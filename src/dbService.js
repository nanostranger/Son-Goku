// src/dbService.js
import mongoose from 'mongoose';

// --- MongoDB Schema for Conversation History ---
const ConversationSchema = new mongoose.Schema({
    // Discord message ID is crucial for editing messages
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

// --- MongoDB Schema for Bot Active Status (Unchanged logic) ---
const BotStatusSchema = new mongoose.Schema({
    serverId: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true }
});
const BotStatus = mongoose.model('BotStatus', BotStatusSchema);

// --- MongoDB Schema for Ignored Messages Tracking ---
const IgnoredMessagesSchema = new mongoose.Schema({
    serverId: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 }, // Number of consecutive ignored messages
});
const IgnoredMessages = mongoose.model('IgnoredMessages', IgnoredMessagesSchema);


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
        // Find the conversation entry by the stored Discord message ID and update content/timestamp
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
        // Fetch 20 most recent messages + logic for retrieving one old relevant message (personal context)
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

// --- Ignored Messages Tracking Functions ---
async function incrementIgnoredCount(serverId) {
    if (!mongoose.connection.readyState) return;
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

// Bot Status functions (unchanged)
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


export {
    connectDB,
    saveMessage,
    editMessage, // NEW
    getConversationHistory,
    setBotActiveStatus,
    getBotActiveStatus,
    incrementIgnoredCount, // NEW
    resetIgnoredCount,     // NEW
    getIgnoredCount        // NEW
};
