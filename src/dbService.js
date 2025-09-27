// src/dbService.js
const mongoose = require('mongoose');

// --- MongoDB Schema for Conversation History ---
const ConversationSchema = new mongoose.Schema({
    // Server ID where the message was sent (for server-based memory)
    serverId: { type: String, required: true },
    // User ID who sent the message (for user-based memory)
    userId: { type: String, required: true },
    // The message text
    content: { type: String, required: true },
    // Role (user or model)
    role: { type: String, required: true, enum: ['user', 'model'] },
    // Timestamp for retrieval/sorting
    timestamp: { type: Date, default: Date.now },
    // File parts for multimodal context storage (optional, for retrieval reference)
    fileParts: [{
        mimeType: String,
        fileUri: String // Stores the Gemini File URI (e.g., files/...)
    }]
});

// A compound index to quickly fetch history for a specific user in a specific server/DM
ConversationSchema.index({ serverId: 1, userId: 1, timestamp: -1 });

const Conversation = mongoose.model('Conversation', ConversationSchema);

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
        await mongoose.connect(mongoUri, {
            // Note: Use the options required by your Mongoose version.
            // Modern Mongoose handles many connection options automatically.
        });
        console.log('MongoDB connected successfully.');
    } catch (error) {
        console.error('MongoDB connection error:', error);
    }
}

/**
 * Saves a message (user or model) to the conversation history.
 * @param {string} serverId - The ID of the server or 'DM' for a direct message.
 * @param {string} userId - The ID of the user.
 * @param {string} content - The text content of the message.
 * @param {string} role - The role ('user' or 'model').
 * @param {Array<Object>} [fileParts=[]] - Array of file part objects from multimodal messages.
 */
async function saveMessage(serverId, userId, content, role, fileParts = []) {
    if (!mongoose.connection.readyState) return;
    try {
        const newMessage = new Conversation({
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
 * Retrieves conversation history for context. It fetches the 20 most recent messages,
 * and then optionally searches for a relevant older message to enable "personal context".
 * @param {string} serverId - The ID of the server or 'DM'.
 * @param {string} userId - The ID of the user.
 * @param {string} currentPrompt - The user's latest prompt for relevance check.
 * @returns {Array<Object>} - An array of message parts structured for the Gemini API.
 */
async function getConversationHistory(serverId, userId, currentPrompt) {
    if (!mongoose.connection.readyState) return [];

    let history = [];
    try {
        // 1. Fetch the 20 most recent messages (sliding window)
        const recentMessages = await Conversation.find({
            $or: [
                { userId: userId, serverId: serverId }, // Current server/DM context
                { userId: userId, serverId: { $ne: serverId } } // User's context across other servers/DMs (for personal context)
            ]
        })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean();

        // 2. Simple retrieval of a single potentially relevant OLD message
        // This simulates the "personal context" feature by looking for a keyword match
        // in messages older than the 20 most recent ones.
        let oldestTimestamp = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1].timestamp : new Date();

        if (recentMessages.length === 20) {
            const keywords = currentPrompt.split(/\s+/).filter(w => w.length > 3).join('|');
            if (keywords.length > 0) {
                const oldRelevantMessage = await Conversation.findOne({
                    userId: userId,
                    timestamp: { $lt: oldestTimestamp },
                    content: { $regex: keywords, $options: 'i' }
                })
                .sort({ timestamp: -1 }) // Get the most recent match from the old messages
                .lean();

                if (oldRelevantMessage) {
                    recentMessages.unshift(oldRelevantMessage); // Add it to the beginning of the context
                    console.log(`[DB] Retrieved old relevant context for user ${userId}.`);
                }
            }
        }
        
        // Convert history into Gemini API format (role/text/inlineData parts)
        // Reverse order to be chronological (oldest first)
        history = recentMessages.reverse().map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
            // For a complete implementation, file parts would also be reconstructed here
            // using the fileUri if they hadn't expired.
        }));

    } catch (error) {
        console.error('Error retrieving conversation history:', error);
    }
    
    return history;
}

/**
 * Resets the conversation history for a specific server/user context.
 * @param {string} serverId - The ID of the server or 'DM'.
 * @param {string} userId - The ID of the user.
 */
async function resetHistory(serverId, userId) {
    if (!mongoose.connection.readyState) return;
    try {
        await Conversation.deleteMany({ serverId: serverId, userId: userId });
        console.log(`History cleared for user ${userId} in ${serverId}.`);
    } catch (error) {
        console.error('Error resetting history:', error);
    }
}

module.exports = {
    connectDB,
    saveMessage,
    getConversationHistory,
    resetHistory
};

