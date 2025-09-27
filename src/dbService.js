// src/dbService.js
import mongoose from 'mongoose'; // Convert require to import

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
        // Note: Modern Mongoose handles connection options automatically.
        await mongoose.connect(mongoUri); 
        console.log('MongoDB connected successfully.');
    } catch (error) {
        console.error('MongoDB connection failed:', error);
    }
}

/**
 * Saves a message (user or model) to the database.
 * @param {string} serverId - The ID of the server or 'DM'.
 * @param {string} userId - The ID of the user.
 * @param {string} content - The message content.
 * @param {string} role - 'user' or 'model'.
 * @param {Array} fileParts - Array of file parts data (optional).
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
        console.error('Error saving message:', error);
    }
}

/**
 * Retrieves the conversation history for a user/server context, ensuring the context
 * length remains manageable.
 * @param {string} serverId - The ID of the server or 'DM'.
 * @param {string} userId - The ID of the user.
 * @param {string} rawPrompt - The user's new prompt (used for old relevant context retrieval).
 * @returns {Array} - Array of history objects in Gemini API format.
 */
async function getConversationHistory(serverId, userId, rawPrompt) {
    if (!mongoose.connection.readyState) return [];

    let history = [];
    try {
        // Fetch the last 15 messages for short-term memory
        let recentMessages = await Conversation.find({ serverId: serverId, userId: userId })
            .sort({ timestamp: -1 }) // Sort by newest first
            .limit(15);
        
        // Simple logic to potentially fetch an older, highly relevant message
        // This is a placeholder for a more advanced retrieval augmented generation (RAG) system.
        if (recentMessages.length < 15) {
            // Placeholder for RAG logic: For simplicity, we just check if any message contains a key phrase
            const relevantKeywords = ['context', 'remember', 'previous', 'last time'];
            if (relevantKeywords.some(keyword => rawPrompt.toLowerCase().includes(keyword))) {
                // Find an older message that contains a common theme or keyword (simple example)
                const oldestTimestamp = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1].timestamp : new Date(0);

                const oldRelevantMessage = await Conversation.findOne({
                    serverId: serverId,
                    userId: userId,
                    timestamp: { $lt: oldestTimestamp }, // Find messages older than the current recent batch
                    content: { $regex: 'important|secret|name', $options: 'i' } // Look for simple relevance
                })
                .sort({ timestamp: -1 });

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

// Convert module.exports to named exports
export {
    connectDB,
    saveMessage,
    getConversationHistory,
    resetHistory
};
