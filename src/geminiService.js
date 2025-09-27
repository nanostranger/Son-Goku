// src/geminiService.js
import { GoogleGenAI, Type } from '@google/genai';
import fetch from 'node-fetch'; // Convert require to import

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
    // In an ESM environment with Node.js 22, Buffer needs to be imported or created differently 
    // depending on the exact setup, but `Buffer.from(arrayBuffer)` generally works or is implicitly available 
    // for this use case. Assuming Buffer is available from Node.js globals for simplicity.
    const buffer = Buffer.from(arrayBuffer); 

    // 2. Upload to Gemini Files API
    const uploadedFile = await geminiClient.files.upload({
        file: buffer,
        mimeType: mimeType,
        displayName: url.substring(url.lastIndexOf('/') + 1)
    });

    console.log(`File uploaded to Gemini: ${uploadedFile.name}`);
    
    // 3. Create the file part for the API call
    const filePart = {
        fileData: {
            mimeType: mimeType,
            fileUri: uploadedFile.uri
        }
    };
    
    return { file: uploadedFile, filePart };
}

/**
 * Generates a text response from the Gemini API.
 * @param {Array} history - The conversation history in Gemini API format.
 * @param {string} prompt - The user's new message.
 * @param {Array} fileParts - An array of Gemini file objects (optional).
 * @returns {Object} - { text: string, sources: Array, isShort: boolean }
 */
async function generateText(history, prompt, fileParts = []) {
    const contents = [
        ...history,
        { 
            role: 'user', 
            parts: [
                ...fileParts.map(fp => fp.fileData), // Attach file parts first
                { text: prompt }
            ] 
        }
    ];

    let text = 'Sorry, I encountered an internal error.';
    let sources = [];
    let isShort = false;

    try {
        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contents,
            config: {
                // Ensure model is set to ground its answer using Google Search
                tools: [{ googleSearch: {} }] 
            }
        });

        text = response.text;
        isShort = response.text.length < 50; // Simple heuristic

        // Extract grounding sources
        const searchChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        sources = searchChunks.map(chunk => ({
            title: chunk.web.title || 'Web Search Result',
            uri: chunk.web.uri
        }));

        // Append sources to the text
        if (sources.length > 0) {
            const citationText = sources.map((s, i) => `[${i + 1}] ${s.title}`).join(', ');
            text += `\n\n(Sources: ${citationText})`;
        }
    
    } catch (error) {
        console.error('Gemini API Error:', error);
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

// Convert module.exports to named exports
export {
    initGemini,
    processAndUploadFile,
    generateText,
    generateImage,
    geminiClient
};
