// index.js
import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, Routes, AttachmentBuilder } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import { log } from 'console';
// Convert require() to import and add .js extensions for local files
import { initGemini, processAndUploadFile, generateText, generateImage, geminiClient } from './geminiService.js'; 
import { connectDB, saveMessage, getConversationHistory, resetHistory } from './dbService.js'; 
// Use 'import 'dotenv/config'' to initialize process.env in an ESM project
import 'dotenv/config'; 


// --- Configuration ---
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const PORT = process.env.PORT || 3000;

// Discord Client Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent, // Required for reading message content
    ],
    partials: [Partials.Channel, Partials.Message],
});

// Initialize services
connectDB();
try {
    initGemini();
} catch (e) {
    log(e.message);
    process.exit(1);
}

// --- Express Keep-Alive Server ---
const app = express();
app.get('/', (req, res) => res.send('Son Goku Bot is running!'));
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

// --- Slash Command Definitions ---
const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Starts a new conversation, clearing the memory for this channel.'),
    new SlashCommandBuilder()
        .setName('imagine')
        .setDescription('Creates an image based on the provided prompt.')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('The detailed prompt for the image you want to create.')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Displays a list of commands and information.')
]

// --- Command Registration (on ready) ---
client.on('ready', async () => {
    log(`Logged in as ${client.user.tag}!`);

    // Register slash commands globally
    const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(DISCORD_CLIENT_ID),
            { body: commands },
        );
        log('Successfully registered application commands.');
    } catch (error) {
        console.error(error);
    }
});

// --- Command Interaction Handler ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;
    const userId = interaction.user.id;
    const serverId = interaction.guildId || 'DM'; // Use 'DM' for direct messages

    if (commandName === 'start') {
        await interaction.deferReply({ ephemeral: true });
        await resetHistory(serverId, userId);
        await interaction.editReply('Conversation history cleared. Ready for a new chat!');
    } else if (commandName === 'imagine') {
        await interaction.deferReply();
        const prompt = interaction.options.getString('prompt');
        
        const imageUrl = await generateImage(prompt);

        if (imageUrl) {
            try {
                // Image URL is a data: URL, we need to convert it to an Attachment
                const base64Data = imageUrl.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                const attachment = new AttachmentBuilder(buffer, { name: 'generated-image.png' });

                await interaction.editReply({ 
                    content: `**Prompt:** *${prompt}*`, 
                    files: [attachment] 
                });
            } catch (error) {
                console.error('Error handling image reply:', error);
                await interaction.editReply('Sorry, I generated an image but ran into an error sending it to Discord.');
            }
        } else {
            await interaction.editReply('Sorry, I could not generate an image with that prompt.');
        }

    } else if (commandName === 'help') {
        await interaction.reply({
            content: "I am Son Goku, a multimodal AI companion powered by Google Gemini. Mention me in any channel, or use my slash commands!\n\n**Commands:**\n`/start`: Clears your conversation history for this channel/DM and starts a new one.\n`/imagine <prompt>`: Generates an image based on your prompt.\n`/help`: Shows this message.\n\n**Note:** To give me context from attachments, simply include a file in your message when you mention me. I can see images, PDFs, text files, and more!",
            ephemeral: true
        });
    }
});

// --- Message Handler (The main AI logic) ---
client.on('messageCreate', async message => {
    // 1. Pre-checks (Ignore bots, DMs/Mentions only)
    if (message.author.bot) return;

    // Determine the context (DM or Guild Channel)
    const isDM = message.channel.type === 1; // DM Channel type
    const serverId = message.guildId || 'DM'; // Use 'DM' for direct messages
    const userId = message.author.id;

    // Check if the bot was mentioned in a server or it's a DM
    const mentioned = message.mentions.has(client.user.id);

    if (!isDM && !mentioned) return;

    // If mentioned, remove the mention from the message content to get the clean prompt
    const rawPrompt = mentioned
        ? message.content.replace(`<@${client.user.id}>`, '').trim()
        : message.content.trim();

    // Ignore empty messages (e.g., just a file upload with a mention)
    if (!rawPrompt && message.attachments.size === 0) return;
    
    // 2. Process Attachments
    const filesToCleanup = [];
    const fileParts = [];

    for (const [key, attachment] of message.attachments) {
        // Only process files if they have a URL and a known mimeType
        if (attachment.url && attachment.contentType) {
            try {
                // Process and upload the file to Gemini Files API
                const { file, filePart } = await processAndUploadFile(attachment.url, attachment.contentType);
                filesToCleanup.push(file);
                fileParts.push(filePart);
                console.log(`Attached file processed: ${file.displayName}`);
            } catch (error) {
                console.error(`Error processing attachment ${attachment.name}:`, error.message);
                // Optionally reply to the user that the file couldn't be processed
                // await message.reply(`Warning: Could not process file ${attachment.name}. The response will be based only on text.`);
            }
        }
    }
    
    // --- Core Interaction Logic ---
    let typingInterval = null;
    let typingStartTime = Date.now();
    
    // Start typing indicator
    await message.channel.sendTyping();
    typingInterval = setInterval(() => {
        try {
            message.channel.sendTyping(); // Refresh typing indicator
        } catch (e) {
            // Channel might have closed, stop refreshing indicator
        }
    }, 5000); // Discord only allows typing indicator for 10 seconds, so refresh it often

    // 3. Retrieve Context
    const history = await getConversationHistory(serverId, userId, rawPrompt);

    // 4. Generate Response
    const { text: responseText, sources } = await generateText(history, rawPrompt, fileParts);
    
    // 5. Stop Typing & Send Response
    clearInterval(typingInterval);
    
    // Ensure minimum typing time for realism (2 seconds)
    const elapsed = Date.now() - typingStartTime;
    if (elapsed < 2000) {
        await new Promise(resolve => setTimeout(resolve, 2000 - elapsed));
    }
    
    try {
        await message.reply(responseText);
        
        // 6. Save both user and model messages to history
        await saveMessage(serverId, userId, rawPrompt, 'user', fileParts.map(fp => ({
            mimeType: fp.fileData.mimeType,
            fileUri: fp.fileData.fileUri
        })));
        await saveMessage(serverId, userId, responseText, 'model');

    } catch (error) {
        console.error('Error sending Discord reply:', error);
    }
    
    // 7. Cleanup Gemini Files
    for (const file of filesToCleanup) {
        try {
            await geminiClient.files.delete({ name: file.name });
            console.log(`Cleaned up Gemini file: ${file.name}`);
        } catch (error) {
            console.warn(`Could not delete Gemini file ${file.name}:`, error.message);
        }
    }
});

// --- Login ---
client.login(DISCORD_BOT_TOKEN);
