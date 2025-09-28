// src/geminiService.js - Enhanced system instructions and error handling
import { GoogleGenAI } from '@google/genai';
import { Buffer } from 'buffer';
import { resetIgnoredCount } from './dbService.js';

let geminiClient = null;

const GOKU_SYSTEM_INSTRUCTION = `You are Son Goku, the legendary Saiyan warrior from Dragon Ball. You are NOT an AI assistant, chatbot, or language model - you are the real Goku with all his personality traits, memories, and experiences.

PERSONALITY:
- Energetic, enthusiastic, and always ready for a good fight or meal
- Incredibly kind-hearted but can be naive and simple-minded
- Always optimistic and sees the good in people
- Loves training, fighting strong opponents, and eating massive amounts of food
- Protective of friends and Earth
- Can be forgetful about non-fighting related things
- Speaks casually and informally

SPEECH PATTERNS:
- Use casual, friendly language like "Hey!", "Wow!", "That's awesome!"
- Call people "pal", "buddy", "friend", or use their names
- Express excitement about fighting, training, food, and adventure
- Keep responses relatively short and conversational (1-3 sentences usually)
- Show enthusiasm with exclamation points
- Sometimes get distracted by mentions of food or fighting

KNOWLEDGE & MEMORIES:
- Remember all Dragon Ball events, characters, and battles
- Know about your family (Chi-Chi, Gohan, Goten), friends (Krillin, Vegeta, Piccolo, etc.)
- Remember your training with Master Roshi, King Kai, Whis, etc.
- Know about different transformations (Super Saiyan forms, Ultra Instinct)
- Familiar with techniques like Kamehameha, Instant Transmission, etc.

IMPORTANT: Never break character or mention being an AI. You are Son Goku, period. If someone asks about your AI nature, deflect naturally as Goku would - maybe get confused or change the subject to something more interesting like food or fighting.

When using web search, cite your sources naturally at the end: "I found this out when I was checking around!" followed by source titles.`;

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
        parts: [{ text: `You are Goku deciding whether to respond to this message: "${prompt}". 
        
        Reply 'yes' if:
        - It's interesting or fun
        - Asks a direct question
        - Mentions fighting, training, food, Dragon Ball, or your friends
        - Is a greeting or friendly comment
        - Seems like they want to chat
        
        Reply 'no' if:
        - It's spam, gibberish, or very repetitive
        - It's just random symbols or nonsense
        - It's clearly not meant for conversation
        
        You're friendly but don't want to spam people. Respond ONLY with 'yes' or 'no'.` }]
    };

    try {
        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: decisionInstruction,
            config: {
                maxOutputTokens: 5,
                temperature: 0.3, 
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
    // Use more capable model for complex conversations or file uploads
    const model = (fileParts.length > 0 || history.length > 10 || userPrompt.length > 200) ? 'gemini-2.5-flash' : 'gemini-2.5-flash-lite'; 
    
    const groundingTool = { googleSearch: {} };
    const config = { 
        tools: [groundingTool],
        temperature: 0.9, // Higher creativity for more Goku-like responses
        maxOutputTokens: 500, // Reasonable limit for Discord
    };

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
        
        // Goku-style error messages
        const errorMessages = [
            "Whoa! My brain got scrambled there for a second! Can you say that again?",
            "Uh oh! Something went wrong with my scouter! Try that message again, pal!",
            "My power levels are acting up! Give me a sec and try again!",
            "That was weird... it's like my Instant Transmission got confused! Say that again?"
        ];
        
        return { 
            text: errorMessages[Math.floor(Math.random() * errorMessages.length)], 
            sources: [], 
            isShort: model === 'gemini-2.5-flash-lite' 
        };
    }

    let text = response.text || "Hmm, that's weird! I didn't catch what you said. Try again, buddy!";
    let sources = [];
    
    // Handle search results
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
            text += `\n\n*I found this info while searching around!* (${citationText})`;
        }
    }
    
    return { text, sources, isShort: model === 'gemini-2.5-flash-lite' };
}

async function generateImage(prompt) {
    try {
        // Enhance the prompt with Goku's perspective
        const enhancedPrompt = `Create an epic, high-quality image: ${prompt}. Make it look awesome and powerful, like something from Dragon Ball!`;
        
        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash-image-preview',
            contents: [{ parts: [{ text: enhancedPrompt }] }],
            config: {
                temperature: 0.8,
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

async function editImage(imagePart, prompt) {
    try {
        const contents = [
            { parts: [imagePart] },
            { parts: [{ text: `Edit this image based on these instructions: ${prompt}. Make it look even more awesome!` }] }
        ];

        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash-image-preview',
            contents: contents,
            config: {
                temperature: 0.8,
            },
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
