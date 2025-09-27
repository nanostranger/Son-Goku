// index.js
const { Client, GatewayIntentBits, Partials, SlashCommandBuilder, Routes, AttachmentBuilder } = require('discord.js');
const { REST } = require('@discordjs/rest');
const express = require('express');
const { initGemini, processAndUploadFile, generateText, generateImage } = require('./src/geminiService');
const { connectDB, saveMessage, getConversationHistory, resetHistory } = require('./src/dbService');
const { log } = require('console');

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
        .setDescription('Starts a new conversation with Son Goku and clears your previous context.'),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Ends the current conversation with Son Goku and clears your context.'),
    new SlashCommandBuilder()
        .setName('imagine')
        .setDescription('Generates an image from a prompt (powered by gemini-2.5-flash-image-preview).')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('The text prompt to generate the image from.')
                .setRequired(true)),
].map(command => command.toJSON());

// --- Register Slash Commands ---
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Use a REST client to deploy the commands globally (or per-guild for faster updates)
    const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

    try {
        console.log('Started refreshing application (/) commands.');
        // Set up commands globally
        await rest.put(
            Routes.applicationCommands(DISCORD_CLIENT_ID),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
});

// --- Command Handling ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, user, channel } = interaction;
    const serverId = interaction.guildId || 'DM'; // Use 'DM' for direct messages
    const userId = user.id;

    await interaction.deferReply(); // Show "Bot is thinking..."

    switch (commandName) {
        case 'start':
            await resetHistory(serverId, userId);
            await interaction.editReply(`Hi there, I'm Son Goku! Your chat history here has been cleared. Let's start fresh! What's on your mind?`);
            break;

        case 'stop':
            await resetHistory(serverId, userId);
            await interaction.editReply(`Conversation ended. Your context has been cleared, and I'll forget what we talked about for now. Thanks for chatting!`);
            break;

        case 'imagine':
            const prompt = interaction.options.getString('prompt');
            await interaction.editReply(`Okay, I'm powering up to generate an image for **"${prompt}"**! Give me a few seconds...`);

            const imageUrl = await generateImage(prompt);

            if (imageUrl) {
                // Remove the 'data:image/png;base64,' prefix for Discord
                const base64Data = imageUrl.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                const attachment = new AttachmentBuilder(buffer, { name: 'goku_image.png' });

                await interaction.editReply({
                    content: `Here is the image for: **"${prompt}"**! Pretty cool, huh?`,
                    files: [attachment]
                });
            } else {
                await interaction.editReply('Oops, I couldn\'t generate that image right now. Something went wrong with my power-up!');
            }
            break;
    }
});

// --- Message Handling (Main Chat Logic) ---
client.on('messageCreate', async message => {
    // Ignore messages from bots, DMs (unless explicitly targeted later), and non-prefix messages
    if (message.author.bot || !message.content.startsWith(`<@${client.user.id}>`)) return;

    const serverId = message.guildId || 'DM';
    const userId = message.author.id;
    const rawPrompt = message.content.replace(`<@${client.user.id}>`, '').trim();

    if (!rawPrompt) {
        message.reply("You called my name, but didn't say anything! What's up?");
        return;
    }
    
    // 1. Multimodal File Handling
    let fileParts = [];
    let filesToCleanup = []; // Array to store Gemini File Objects for deletion
    
    // Check for file attachments
    const attachments = Array.from(message.attachments.values());

    for (const attachment of attachments) {
        try {
            // Process the attachment: download from Discord, upload to Gemini Files API
            const { file, filePart } = await processAndUploadFile(attachment.url, attachment.contentType);
            fileParts.push(filePart);
            filesToCleanup.push(file); // Store file to delete after response
        } catch (error) {
            console.error('Error processing attachment:', error);
            message.reply(`I had trouble processing the file: ${attachment.name}. I'll try to answer your text prompt without it.`);
        }
    }

    // 2. Typing Simulation (Realistic Delay)
    // We base the typing time on the expected model (flash-lite for short, flash for long)
    const isShortQuery = rawPrompt.length < 50 && fileParts.length === 0;
    const maxTypingDelay = isShortQuery ? 2000 : 8000; // 2s for lite, up to 8s for flash
    const typingStartTime = Date.now();
    const typingInterval = setInterval(() => {
        // Stop typing after the maximum delay, if the response hasn't arrived
        if (Date.now() - typingStartTime > maxTypingDelay) {
            clearInterval(typingInterval);
        } else {
            message.channel.sendTyping().catch(console.error); // Send typing indicator
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

client.login(DISCORD_BOT_TOKEN);
