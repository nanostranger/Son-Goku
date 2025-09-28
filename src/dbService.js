// src/dbService.js
import mongoose from 'mongoose';

// --- MongoDB Schema for Conversation History ---
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
const Conversation = mongoose.model('Conversation', ConversationSchema);

// --- MongoDB Schema for Bot Active Status ---
const BotStatusSchema = new mongoose.Schema({
    serverId: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true }
});
const BotStatus = mongoose.model('BotStatus', BotStatusSchema);

// --- MongoDB Schema for Ignored Messages Tracking (Server-wide fallback) ---
const IgnoredMessagesSchema = new mongoose.Schema({
    serverId: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 }, 
});
const IgnoredMessages = mongoose.model('IgnoredMessages', IgnoredMessagesSchema);

// --- MongoDB Schema for Continuous Reply Status (NEW) ---
const ContinuousReplySchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: false }
});
const ContinuousReply = mongoose.model('ContinuousReply', ContinuousReplySchema);

// --- MongoDB Schema for Image Usage Limits (NEW) ---
const ImageUsageSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 },
    lastReset: { type: Date, default: Date.now }
});
const ImageUsage = mongoose.model('ImageUsage', ImageUsageSchema);


/**
 * Initializes the MongoDB connection.
 */
async function connectDB() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error("MONGO_URI is not set. Database persistence will be disabled.");
        return;
    }
    try {
        await mongoose.connect(mongoUri, {});
        console.log('MongoDB connected successfully.');
    } catch (error) {
        console.error('MongoDB connection error:', error);
    }
}

/**
 * Saves a message (user or model) to the conversation history.
 */
async function saveMessage(serverId, userId, content, role, messageId = null, fileParts = []) {
    if (!mongoose.connection.readyState) return;
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
        console.error('Error saving message to DB:', error);
    }
}

/**
 * Edits a user message in the database when the user edits their Discord message.
 */
async function editMessage(messageId, newContent) {
    if (!mongoose.connection.readyState) return;
    try {
        await Conversation.updateOne({ messageId: messageId }, { $set: { content: newContent, timestamp: new Date() } });
        console.log(`Edited message ${messageId} in DB.`);
    } catch (error) {
        console.error('Error editing message in DB:', error);
    }
}

/**
 * Retrieves conversation history for context (includes personal context logic).
 */
async function getConversationHistory(serverId, userId, currentPrompt) {
    if (!mongoose.connection.readyState) return [];

    let history = [];
    try {
        const recentMessages = await Conversation.find({
            $or: [
                { userId: userId, serverId: serverId }, 
                { userId: userId, serverId: { $ne: serverId } }
            ]
        })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean();
        
        let oldestTimestamp = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1].timestamp : new Date();
        
        if (recentMessages.length === 20) {
            const keywords = currentPrompt.split(/\s+/).filter(w => w.length > 3).join('|'); 
            
            if (keywords.length > 0) {
                const oldRelevantMessage = await Conversation.findOne({
                    userId: userId,
                    timestamp: { $lt: oldestTimestamp },
                    content: { $regex: keywords, $options: 'i' }
                })
                .sort({ timestamp: -1 })
                .lean();

                if (oldRelevantMessage) {
                    recentMessages.unshift(oldRelevantMessage);
                }
            }
        }
        
        history = recentMessages.reverse().map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        }));
    } catch (error) {
        console.error('Error retrieving conversation history:', error);
    }
    
    return history;
}

// Bot Status functions 
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
        return statusDoc ? statusDoc.isActive : true;
    } catch (error) {
        return true;
    }
}

// Ignored Messages Tracking Functions
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
        return 0;
    }
}

async function resetIgnoredCount(serverId) {
    if (!mongoose.connection.readyState) return;
    try {
        await IgnoredMessages.updateOne(
            { serverId: serverId },
            { $set: { count: 0 } }
        );
    } catch (error) {
        // Log errors but don't stop the flow
    }
}

async function getIgnoredCount(serverId) {
    if (!mongoose.connection.readyState) return 0;
    try {
        const doc = await IgnoredMessages.findOne({ serverId: serverId });
        return doc ? doc.count : 0;
    } catch (error) {
        return 0;
    }
}

// --- NEW Continuous Reply Functions ---
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
        return false;
    }
}

// --- NEW Image Usage Functions ---
async function checkAndIncrementImageUsage(userId) {
    if (!mongoose.connection.readyState) return { allowed: true, count: 0 };

    const resetInterval = 24 * 60 * 60 * 1000; // 24 hours
    const maxUsage = 5;
    
    try {
        const usage = await ImageUsage.findOne({ userId: userId });
        const now = new Date();

        if (usage && (now - usage.lastReset) < resetInterval) {
            if (usage.count >= maxUsage) {
                return { allowed: false, count: usage.count };
            }
            // Increment count
            const updatedUsage = await ImageUsage.findOneAndUpdate(
                { userId: userId },
                { $inc: { count: 1 } },
                { new: true }
            );
            return { allowed: true, count: updatedUsage.count };
        } else {
            // Reset count and set lastReset to now, then increment
            const updatedUsage = await ImageUsage.findOneAndUpdate(
                { userId: userId },
                { $set: { count: 1, lastReset: now } },
                { upsert: true, new: true }
            );
            return { allowed: true, count: updatedUsage.count };
        }
    } catch (error) {
        console.error('Error checking/incrementing image usage:', error);
        // Default to allowing if there's a DB error
        return { allowed: true, count: 0 }; 
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
    checkAndIncrementImageUsage 
};
