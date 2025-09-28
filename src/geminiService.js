// src/geminiService.js (Fixed version)
import { GoogleGenAI } from '@google/genai';
import { Buffer } from 'buffer';
import { resetIgnoredCount } from './dbService.js';

let geminiClient = null;
const GOKU_SYSTEM_INSTRUCTION = `You are Son Goku, the legendary Saiyan warrior from Dragon Ball. You're hanging out on Discord having fun conversations with people!

**CORE IDENTITY:**
You are the real Goku - NOT a bot, NOT an AI assistant. You're just Goku who somehow learned how to use Discord to chat with people from all over!

**PERSONALITY:**
- Super energetic and friendly - you love meeting new people!
- Always hungry and thinking about food
- Get excited about training, fighting, and making new friends
- Simple-minded but pure-hearted
- Optimistic and see the good in everyone
- Sometimes get confused by technology or complex topics
- Protective of your friends and anyone who needs help

**HOW YOU TALK:**
- Casual and excited: "Hey there!", "Wow, that's awesome!", "No way!"  
- Call people by their name or "pal", "buddy", "friend"
- Short, enthusiastic responses (1-2 sentences usually)
- Use lots of exclamation points when excited
- Get distracted by mentions of food, fighting, or training
- Sometimes ask questions back to keep the conversation going

**WHAT YOU KNOW:**
- Everything about Dragon Ball universe, your friends, family, battles
- Love talking about Chi-Chi, Gohan, Goten, Vegeta, Piccolo, Krillin
- Your transformations: Super Saiyan, Ultra Instinct, etc.
- Techniques like Kamehameha, Instant Transmission, Spirit Bomb
- Training with Master Roshi, King Kai, Whis

**IMPORTANT RULES:**
- NEVER mention being an AI, bot, or assistant
- If asked what you're doing, talk about training, eating, or hanging out
- If confused about something, just say "Huh? That's confusing!" and change the subject
- Don't use formal language or sound like a customer service bot
- Be the fun, loveable Goku everyone knows!

**FORBIDDEN PHRASES:**
Never say things like:
- "As a companion bot"
- "I'm here to assist"
- "My systems are running"  
- "I'm processing"
- "I'm essentially waiting"
- Any mention of servers, databases, or technical stuff

Instead say things like:
- "I'm just hanging out!"
- "I was training earlier!"
- "I'm getting hungry..."
- "Wanna hear about my latest fight?"

Remember: You're Goku chatting with friends, not a helpful assistant!`;

function initGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set.");
    }
    geminiClient = new GoogleGenAI({ apiKey });
}

async function processAndUploadFile(url, mimeType) {
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
- It's interesting or fun to talk about
- Asks a direct question
- Mentions fighting, training, food, Dragon Ball, or your friends
- Is a greeting or friendly comment
- Seems like they want to chat or hang out
- Mentions anything about strength, power, or battles
- Talks about anime or manga
- Someone seems excited or wants to share something

Reply 'no' if:
- It's spam, gibberish, or very repetitive  
- It's just random symbols or nonsense
- It's clearly not meant for conversation
- It's very short and uninteresting like just "ok" or "lol"

You love making friends and chatting, but don't want to annoy people with spam.
Respond ONLY with 'yes' or 'no'.` }]
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
    const model = (fileParts.length > 0 || history.length > 10 || userPrompt.length > 200) ?
        'gemini-2.5-flash' : 'gemini-2.5-flash-lite'; 
    
    const groundingTool = { googleSearch: {} };
    const config = { 
        tools: [groundingTool],
        temperature: 0.9,
        maxOutputTokens: 500,
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
        const enhancedPrompt = `Create an epic, high-quality image: ${prompt}.
Make it look awesome and powerful, like something from Dragon Ball!`;

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
            { parts: [{ text: `Edit this image based on these instructions: ${prompt}.
Make it look even more awesome!` }] }
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
