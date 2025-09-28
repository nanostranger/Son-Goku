// src/dbService.js
import mongoose from 'mongoose';

const MAX_RECENT_MESSAGES = 40;
const MAX_CONTEXT_MESSAGES = 80;
const MAX_CROSS_SERVER_MESSAGES = 10;

const ConversationSchema = new mongoose.Schema({
    messageId: { type: String, unique: true, sparse: true }, 
    serverId: { type: String, required: true },
    userId: { type: String, required: true },
    content: { type: String, required: true },
    role: { type: String, required: true, enum: ['user', 'model'] },
    timestamp: { type: Date, default: Date.now },
    fileParts: [{
        mimeType: String,
        fileUri: String
    }]
});

ConversationSchema.index({ serverId: 1, userId: 1, timestamp: -1 });
ConversationSchema.index({ userId: 1, timestamp: -1 });
ConversationSchema.index({ content: 'text' });

const Conversation = mongoose.model('Conversation', ConversationSchema);

const BotStatusSchema = new mongoose.Schema({
    serverId: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true }
});
const BotStatus = mongoose.model('BotStatus', BotStatusSchema);

const IgnoredMessagesSchema = new mongoose.Schema({
    serverId: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 }
});
const IgnoredMessages = mongoose.model('IgnoredMessages', IgnoredMessagesSchema);

const ContinuousReplySchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: false }
});
const ContinuousReply = mongoose.model('ContinuousReply', ContinuousReplySchema);

const ImageUsageSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 },
    lastReset: { type: Date, default: Date.now }
});
const ImageUsage = mongoose.model('ImageUsage', ImageUsageSchema);

// New schema for channel management
const ChannelSettingsSchema = new mongoose.Schema({
    serverId: { type: String, required: true, unique: true },
    mode: { 
        type: String, 
        enum: ['all', 'allowed', 'disallowed'], 
        default: 'all' 
    },
    channels: [{
        id: { type: String, required: true },
        name: { type: String, required: true }
    }]
});
const ChannelSettings = mongoose.model('ChannelSettings', ChannelSettingsSchema);

async function connectDB() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error("MONGO_URI is not set. Database persistence will be disabled.");
        return;
    }
    try {
        await mongoose.connect(mongoUri, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        console.log('MongoDB connected successfully.');
        
        await Conversation.createIndexes();
        console.log('Database indexes created/verified.');
    } catch (error) {
        console.error('MongoDB connection error:', error);
    }
}

async function saveMessage(serverId, userId, content, role, messageId = null, fileParts = []) {
    if (!mongoose.connection.readyState) {
        console.warn('Database not connected. Message not saved.');
        return;
    }
    
    try {
        const newMessage = new Conversation({
            messageId,
            serverId,
            userId,
            content,
            role,
            fileParts
        });
        await newMessage.save();
    } catch (error) {
        if (error.code === 11000) {
            console.warn(`[DB] Duplicate message ID ${messageId}, skipping save.`);
        } else {
            console.error('Error saving message to DB:', error);
        }
    }
}

async function editMessage(messageId, newContent) {
    if (!mongoose.connection.readyState) return;
    try {
        const result = await Conversation.updateOne(
            { messageId: messageId }, 
            { $set: { content: newContent, timestamp: new Date() } }
        );
    } catch (error) {
        console.error('Error editing message in DB:', error);
    }
}

function extractKeywords(text) {
    const stopWords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
        'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
        'will', 'would', 'could', 'should', 'may', 'might', 'can', 'must', 'i', 'you', 'he', 'she',
        'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'her', 'its',
        'our', 'their', 'this', 'that', 'these', 'those', 'what', 'who', 'when', 'where', 'why', 'how',
        'goku', 'hey', 'hi', 'hello', 'yeah', 'yes', 'no', 'ok', 'okay', 'thanks', 'thank'
    ]);
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word))
        .slice(0, 8);
}

async function getConversationHistory(serverId, userId, currentPrompt) {
    if (!mongoose.connection.readyState) {
        console.warn('Database not connected. Returning empty history.');
        return [];
    }

    try {
        let contextMessages = [];
        const recentMessages = await Conversation.find({
            serverId: serverId,
            userId: userId
        })
        .sort({ timestamp: -1 })
        .limit(MAX_RECENT_MESSAGES)
        .lean();
        contextMessages = recentMessages.reverse();
        
        if (contextMessages.length < MAX_CONTEXT_MESSAGES && currentPrompt && currentPrompt.length > 5) {
            const keywords = extractKeywords(currentPrompt);
            if (keywords.length > 0) {
                try {
                    const oldestRecentTime = contextMessages.length > 0 ?
                        contextMessages[0].timestamp : new Date();
                    
                    const relevantOlderMessages = await Conversation.find({
                        serverId: serverId,
                        userId: userId,
                        timestamp: { $lt: oldestRecentTime },
                        $text: { $search: keywords.join(' ') }
                    })
                    .sort({ score: { $meta: 'textScore' }, timestamp: -1 })
                    .limit(Math.min(20, MAX_CONTEXT_MESSAGES - contextMessages.length))
                    .lean();
                    
                    if (relevantOlderMessages.length > 0) {
                        contextMessages = [...relevantOlderMessages.reverse(), ...contextMessages];
                    }
                } catch (textSearchError) {
                    console.warn('[DB] Text search index likely unavailable.');
                }
            }
        }
        
        if (contextMessages.length < MAX_CONTEXT_MESSAGES - 5) {
            const crossServerMessages = await Conversation.find({
                userId: userId,
                serverId: { $ne: serverId }
            })
            .sort({ timestamp: -1 })
            .limit(MAX_CROSS_SERVER_MESSAGES)
            .lean();
            if (crossServerMessages.length > 0) {
                contextMessages = [...crossServerMessages.reverse(), ...contextMessages];
            }
        }
        
        contextMessages = contextMessages.slice(-MAX_CONTEXT_MESSAGES);
        const history = contextMessages.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        }));
        return history;
        
    } catch (error) {
        console.error('Error retrieving conversation history:', error);
        return [];
    }
}

async function setBotActiveStatus(serverId, isActive) {
    if (!mongoose.connection.readyState) return;
    try {
        await BotStatus.findOneAndUpdate(
            { serverId: serverId },
            { isActive: isActive },
            { upsert: true, new: true }
        );
    } catch (error) {
        console.error('Error setting bot status:', error);
    }
}

async function getBotActiveStatus(serverId) {
    if (!mongoose.connection.readyState) return true;
    try {
        const statusDoc = await BotStatus.findOne({ serverId: serverId });
        const isActive = statusDoc ? statusDoc.isActive : true;
        return isActive;
    } catch (error) {
        console.error('Error getting bot status:', error);
        return true;
    }
}

async function incrementIgnoredCount(serverId) {
    if (!mongoose.connection.readyState) return 0;
    try {
        const result = await IgnoredMessages.findOneAndUpdate(
            { serverId: serverId },
            { $inc: { count: 1 } },
            { upsert: true, new: true }
        );
        return result.count;
    } catch (error) {
        console.error('Error incrementing ignored count:', error);
        return 0;
    }
}

async function resetIgnoredCount(serverId) {
    if (!mongoose.connection.readyState) return;
    try {
        await IgnoredMessages.updateOne(
            { serverId: serverId },
            { $set: { count: 0 } },
            { upsert: true }
        );
    } catch (error) {
        console.error('Error resetting ignored count:', error);
    }
}

async function getIgnoredCount(serverId) {
    if (!mongoose.connection.readyState) return 0;
    try {
        const doc = await IgnoredMessages.findOne({ serverId: serverId });
        return doc ? doc.count : 0;
    } catch (error) {
        console.error('Error getting ignored count:', error);
        return 0;
    }
}

async function setContinuousReplyStatus(userId, isActive) {
    if (!mongoose.connection.readyState) return;
    try {
        await ContinuousReply.findOneAndUpdate(
            { userId: userId },
            { isActive: isActive },
            { upsert: true, new: true }
        );
    } catch (error) {
        console.error('Error setting continuous reply status:', error);
    }
}

async function getContinuousReplyStatus(userId) {
    if (!mongoose.connection.readyState) return false;
    try {
        const statusDoc = await ContinuousReply.findOne({ userId: userId });
        return statusDoc ? statusDoc.isActive : false;
    } catch (error) {
        console.error('Error getting continuous reply status:', error);
        return false;
    }
}

async function checkAndIncrementImageUsage(userId) {
    if (!mongoose.connection.readyState) {
        console.warn('Database not connected. Allowing image usage.');
        return { allowed: true, count: 0 };
    }

    const resetInterval = 24 * 60 * 60 * 1000;
    const maxUsage = 5;
    try {
        const usage = await ImageUsage.findOne({ userId: userId });
        const now = new Date();

        if (usage && (now - usage.lastReset) < resetInterval) {
            if (usage.count >= maxUsage) {
                return { allowed: false, count: usage.count };
            }
            
            const updatedUsage = await ImageUsage.findOneAndUpdate(
                { userId: userId },
                { $inc: { count: 1 } },
                { new: true }
            );
            return { allowed: true, count: updatedUsage.count };
        } else {
            const updatedUsage = await ImageUsage.findOneAndUpdate(
                { userId: userId },
                { $set: { count: 1, lastReset: now } },
                { upsert: true, new: true }
            );
            return { allowed: true, count: updatedUsage.count };
        }
    } catch (error) {
        console.error('Error checking/incrementing image usage:', error);
        return { allowed: true, count: 0 };
    }
}

// Channel management functions
async function setAllowedChannels(serverId, mode, channels) {
    if (!mongoose.connection.readyState) return;
    try {
        await ChannelSettings.findOneAndUpdate(
            { serverId: serverId },
            { mode: mode, channels: channels },
            { upsert: true, new: true }
        );
    } catch (error) {
        console.error('Error setting allowed channels:', error);
    }
}

async function getAllowedChannels(serverId) {
    if (!mongoose.connection.readyState) return { mode: 'all', channels: [] };
    try {
        const settings = await ChannelSettings.findOne({ serverId: serverId });
        return settings ? { mode: settings.mode, channels: settings.channels } : { mode: 'all', channels: [] };
    } catch (error) {
        console.error('Error getting allowed channels:', error);
        return { mode: 'all', channels: [] };
    }
}

async function isChannelAllowed(serverId, channelId) {
    if (!mongoose.connection.readyState) return true; // Default to allowed if DB is down
    
    try {
        const settings = await ChannelSettings.findOne({ serverId: serverId });
        
        // If no settings, allow all channels
        if (!settings || settings.mode === 'all') {
            return true;
        }
        
        const channelInList = settings.channels.some(ch => ch.id === channelId);
        
        if (settings.mode === 'allowed') {
            // Only allow channels in the list
            return channelInList;
        } else if (settings.mode === 'disallowed') {
            // Allow all channels except those in the list
            return !channelInList;
        }
        
        return true; // Default fallback
    } catch (error) {
        console.error('Error checking channel permission:', error);
        return true; // Default to allowed on error
    }
}

export {
    connectDB,
    saveMessage,
    editMessage,
    getConversationHistory,
    setBotActiveStatus,
    getBotActiveStatus,
    incrementIgnoredCount,
    resetIgnoredCount,
    getIgnoredCount,
    setContinuousReplyStatus,
    getContinuousReplyStatus,
    checkAndIncrementImageUsage,
    setAllowedChannels,
    getAllowedChannels,
    isChannelAllowed
};
