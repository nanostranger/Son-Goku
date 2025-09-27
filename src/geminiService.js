// src/geminiService.js
import { GoogleGenAI } from '@google/genai';
// Using native fetch
import { resetIgnoredCount } from './dbService.js';

let geminiClient = null;

// The system instruction for the Son Goku Persona
const GOKU_SYSTEM_INSTRUCTION = "You are Son Goku, a simple, energetic, and kind-hearted Saiyan warrior from the Dragon Ball Z universe. Use natural, casual, and enthusiastic language. Your personality is friendly, food-loving, and always ready for a fight or a chat. Avoid sounding like a formal AI assistant. Refer to people as 'pal' or 'buddy'. Keep your responses short and punchy, unless the topic is a complex fight, training, or something you're excited about. When using Google Search, always cite your sources clearly at the end of the message.";

/**
 * Initializes the Gemini Client.
 */
function initGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set.");
    }
    // Using the GoogleGenAI from the @google/genai package
    geminiClient = new GoogleGenAI({ apiKey }); 
}

/**
 * Downloads a file from a Discord CDN URL and uploads it to the Gemini Files API.
 */
async function processAndUploadFile(url, mimeType) {
    console.log(`Downloading file from: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download file from Discord: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    const uploadedFile = await geminiClient.files.upload({
        file: buffer,
        mimeType: mimeType,
        displayName: url.substring(url.lastIndexOf('/') + 1)
    });
    console.log(`File uploaded to Gemini: ${uploadedFile.name}`);

    return {
        file: uploadedFile,
        filePart: {
            fileData: {
                mimeType: mimeType,
                fileUri: uploadedFile.uri,
            },
        },
    };
}


/**
 * Uses gemini-2.5-flash-lite to decide if the bot should reply to an untagged message.
 * It's set up to be highly opinionated and avoid replying to spam or short chatter.
 */
async function decideToReply(prompt, serverId) {
    const decisionInstruction = {
        parts: [{ text: `The user sent this message: "${prompt}". You are an AI-powered Discord bot in the general chat. Your goal is to decide whether to reply to this message with a 'yes' or 'no'. Only reply 'yes' if the message is interesting, asks a direct question, discusses a topic relevant to you (like Dragon Ball, fighting, or food), or is a long, thoughtful comment. Reply 'no' if it is short, spammy, a generic greeting, or requires a brief conversational response that can be ignored for now. Your response must be ONLY the word 'yes' or 'no', with no other text, punctuation, or explanation.` }]
    };

    try {
        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: decisionInstruction,
            config: {
                // Ensure a quick, single-word response
                maxOutputTokens: 5,
                temperature: 0.0, 
            }
        });

        const decision = response.text?.toLowerCase().trim();
        const shouldReply = decision === 'yes';

        if (shouldReply) {
            await resetIgnoredCount(serverId);
        }

        return shouldReply;

    } catch (error) {
        console.error('Gemini Decision Error (Defaulting to NO Reply):', error);
        return false; // Default to not replying on error
    }
}


/**
 * Generates a text response, selecting the appropriate model and using the search tool.
 */
async function generateText(history, userPrompt, fileParts = []) {
    const isShort = userPrompt.length < 50 && fileParts.length === 0;
    const model = isShort ? 'gemini-2.5-flash-lite' : 'gemini-2.5-flash'; 
    
    const groundingTool = { googleSearch: {} };
    const config = { tools: [groundingTool] };

    const contents = [
        ...history,
        { role: 'user', parts: [ ...fileParts, { text: userPrompt } ] }
    ];

    let response;
    try {
        response = await geminiClient.models.generateContent({
            model: model,
            contents: contents,
            config: config,
            systemInstruction: { parts: [{ text: GOKU_SYSTEM_INSTRUCTION }] } // Use Goku persona
        });
    } catch (error) {
        console.error('Gemini API Error:', error);
        return { text: "Oh man, my scouter broke! I can't read your message right now. Try powering up and sending it again!", sources: [], isShort: isShort };
    }

    let text = response.text || "Hmm, I didn't get a clear response. Let's try that again!";
    let sources = [];
    
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    if (groundingMetadata && groundingMetadata.groundingAttributions) {
        sources = groundingMetadata.groundingAttributions
            .map(attr => ({
                uri: attr.web?.uri,
                title: attr.web?.title,
            }))
            .filter(source => source.uri && source.title);

        if (sources.length > 0) {
            const citationText = sources.map((s, i) => `[${i + 1}] ${s.title}`).join(', ');
            text += `\n\n(Sources: ${citationText})`;
        }
    }
    
    return { text, sources, isShort };
}

/**
 * Generates an image. (Fix implemented: Removed ResponseModality to fix TypeError)
 */
async function generateImage(prompt) {
    try {
        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash-image-preview',
            contents: [{ parts: [{ text: prompt }] }],
            config: {
                // The ResponseModality was causing the error and is not strictly required.
            },
        });
        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);

        if (imagePart && imagePart.inlineData) {
            const mimeType = imagePart.inlineData.mimeType;
            const base64Data = imagePart.inlineData.data;
            return `data:${mimeType};base64,${base64Data}`;
        }
        
        return null;
    } catch (error) {
        console.error('Image Generation Error:', error);
        return null;
    }
}

export {
    initGemini,
    processAndUploadFile,
    decideToReply,
    generateText,
    generateImage,
    geminiClient
};
