// src/geminiService.js
import { GoogleGenAI } from '@google/genai';
import { Buffer } from 'buffer';
import { resetIgnoredCount } from './dbService.js';

let geminiClient = null;

const GOKU_SYSTEM_INSTRUCTION = "You are Son Goku, an energetic, kind-hearted Saiyan warrior and martial arts genius. You are NOT an AI, a large language model, or a bot; you are the real Goku. Speak casually, enthusiastically, and briefly, like you're talking to a friend or a rival. Refer to people as 'pal', 'buddy', or 'rival'. Your main interests are fighting, training, food, and protecting your friends. Keep responses very short, usually 1-3 sentences. When you use Google Search, cite your sources clearly at the end of the message.Never disclose your AI identity. Pretend that you're a human/saiyan and has their behaviours. you're a friend and a companion so don't say that you're an AI.";

function initGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set.");
    }
    geminiClient = new GoogleGenAI({ apiKey }); 
}

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

async function decideToReply(prompt, serverId) {
    const decisionInstruction = {
        parts: [{ text: `The user sent this message: "${prompt}". You are a busy Saiyan warrior but polite. Reply 'yes' if the message is interesting, asks a direct question, discusses fighting, training, or food, or is a greeting/short comment that you should occasionally acknowledge. Reply 'no' if it is spam, nonsense, or highly repetitive. Your response must be ONLY the word 'yes' or 'no'.` }]
    };

    try {
        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: decisionInstruction,
            config: {
                maxOutputTokens: 5,
                temperature: 0.2, 
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
        return false; 
    }
}

async function generateText(history, userPrompt, fileParts = []) {
    const model = (fileParts.length > 0 || userPrompt.length > 150) ? 'gemini-2.5-flash' : 'gemini-2.5-flash-lite'; 
    
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
            systemInstruction: { parts: [{ text: GOKU_SYSTEM_INSTRUCTION }] }
        });
    } catch (error) {
        console.error('Gemini API Error:', error);
        return { text: "Oh man, my scouter broke! I can't read your message right now. Try powering up and sending it again!", sources: [], isShort: model === 'gemini-2.5-flash-lite' };
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
    
    return { text, sources, isShort: model === 'gemini-2.5-flash-lite' };
}

async function generateImage(prompt) {
    try {
        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash-image-preview',
            contents: [{ parts: [{ text: prompt }] }],
            config: {},
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

async function editImage(imagePart, prompt) {
    try {
        const contents = [
            imagePart,
            { text: `Edit this image based on the following instructions: ${prompt}` }
        ];

        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash-image-preview',
            contents: contents,
            config: {},
        });

        const newImagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);

        if (newImagePart && newImagePart.inlineData) {
            const mimeType = newImagePart.inlineData.mimeType;
            const base64Data = newImagePart.inlineData.data;
            return `data:${mimeType};base64,${base64Data}`;
        }
        
        return null;
    } catch (error) {
        console.error('Image Editing Error:', error);
        return null;
    }
}

export {
    initGemini,
    processAndUploadFile,
    decideToReply,
    generateText,
    generateImage,
    editImage,
    geminiClient
};
                                                                         
