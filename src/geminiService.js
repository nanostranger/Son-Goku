// src/geminiService.js
const { GoogleGenAI, Type } = require('@google/genai');
const fetch = require('node-fetch');

let geminiClient = null;

/**
 * Initializes the Gemini Client.
 */
function initGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set.");
    }
    geminiClient = new GoogleGenAI({ apiKey });
}

/**
 * Downloads a file from a Discord CDN URL and uploads it to the Gemini Files API.
 * This is the preferred method for handling large files (video/audio/documents).
 * @param {string} url - Discord CDN URL.
 * @param {string} mimeType - File MIME type.
 * @returns {Object} - Gemini File Object { file, filePart }
 */
async function processAndUploadFile(url, mimeType) {
    console.log(`Downloading file from: ${url}`);
    
    // 1. Download file data
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download file from Discord: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 2. Upload to Gemini Files API
    const uploadedFile = await geminiClient.files.upload({
        file: buffer,
        mimeType: mimeType,
        displayName: url.substring(url.lastIndexOf('/') + 1)
    });

    console.log(`File uploaded to Gemini: ${uploadedFile.name}`);

    // The Gemini File Object is used for cleanup (deletion) later.
    // The File Part is what's included in the prompt payload.
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
 * Generates a text response, selecting the appropriate model and using the search tool.
 * @param {Array<Object>} history - Conversation history parts.
 * @param {string} userPrompt - The latest user prompt text.
 * @param {Array<Object>} [fileParts=[]] - Array of multimodal file parts.
 * @returns {Object} - { text: string, sources: Array<Object>, isShort: boolean }
 */
async function generateText(history, userPrompt, fileParts = []) {
    const isShort = userPrompt.length < 50 && fileParts.length === 0;
    const model = isShort ? 'gemini-2.5-flash-lite' : 'gemini-2.5-flash';
    
    const groundingTool = { googleSearch: {} };
    const config = {
        tools: [groundingTool],
    };

    // System instruction to define the persona
    const systemInstruction = {
        parts: [{ text: "You are Son Goku, a friendly, human-like AI companion. Use natural, simple, and casual language. Avoid robotic signifiers. Keep short responses concise using gemini-2.5-flash-lite and more detailed responses using gemini-2.5-flash. When using Google Search, always cite your sources clearly at the end of the message." }]
    };

    // Construct the contents array
    const userMessageParts = [
        ...fileParts,
        { text: userPrompt }
    ];

    const contents = [
        ...history,
        { role: 'user', parts: userMessageParts }
    ];

    let response;
    try {
        response = await geminiClient.models.generateContent({
            model: model,
            contents: contents,
            config: config,
            systemInstruction: systemInstruction
        });
    } catch (error) {
        console.error('Gemini API Error:', error);
        return { text: "Oh no! I ran into a snag while trying to process that. My power level must be too low right now. Try again in a bit!", sources: [], isShort: isShort };
    }

    let text = response.text || "Hmm, I didn't get a clear response. Let's try that again!";
    let sources = [];
    
    // Extract citations
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    if (groundingMetadata && groundingMetadata.groundingAttributions) {
        sources = groundingMetadata.groundingAttributions
            .map(attr => ({
                uri: attr.web?.uri,
                title: attr.web?.title,
            }))
            .filter(source => source.uri && source.title);
            
        // Append citations to the text
        if (sources.length > 0) {
            const citationText = sources.map((s, i) => `[${i + 1}] ${s.title}`).join(', ');
            text += `\n\n(Sources: ${citationText})`;
        }
    }
    
    return { text, sources, isShort };
}

/**
 * Generates an image using the /imagine command.
 * @param {string} prompt - The image generation prompt.
 * @returns {string} - Base64 image data URL or error message.
 */
async function generateImage(prompt) {
    try {
        // Use gemini-2.5-flash-image-preview for image generation
        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash-image-preview',
            contents: [{ parts: [{ text: prompt }] }],
            config: {
                responseModalities: [Type.ResponseModality.IMAGE],
                // Optionally add more configuration like image size, style, etc. here
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

module.exports = {
    initGemini,
    processAndUploadFile,
    generateText,
    generateImage,
};
