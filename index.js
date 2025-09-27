// index.js
import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, Routes, AttachmentBuilder, PermissionsBitField } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import { initGemini, processAndUploadFile, generateText, generateImage, geminiClient } from './src/geminiService.js';
import { connectDB, saveMessage, getConversationHistory, resetHistory, setBotActiveStatus, getBotActiveStatus } from './src/dbService.js';
import { log } from 'console';

// --- Configuration ---
// Note: This bot expects environment variables DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, and PORT.
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

/**
 * Splits a response into multiple messages if it exceeds Discord's 2000 character limit.
 * @param {string} text The full text response.
 * @returns {Array<string>} An array of message strings.
 */
function splitLongResponse(text) {
    const MAX_LENGTH = 2000;
    const messages = [];
    if (text.length <= MAX_LENGTH) {
        messages.push(text);
        return messages;
    }

    let currentText = text;
    while (currentText.length > 0) {
        // Find a natural break (newline or sentence end) near the limit
        let chunk = currentText.substring(0, MAX_LENGTH);
        let splitIndex = MAX_LENGTH;

        if (currentText.length > MAX_LENGTH) {
            let lastNewline = chunk.lastIndexOf('\n');
            let lastSentenceEnd = Math.max(chunk.lastIndexOf('.'), chunk.lastIndexOf('!'), chunk.lastIndexOf('?'));

            // Prioritize newline, then sentence end, otherwise just split at MAX_LENGTH
            if (lastNewline !== -1 && MAX_LENGTH - lastNewline < 100) {
                splitIndex = lastNewline + 1;
            } else if (lastSentenceEnd !== -1 && MAX_LENGTH - lastSentenceEnd < 100) {
                splitIndex = lastSentenceEnd + 1;
            }
        } else {
            splitIndex = currentText.length;
        }

        messages.push(currentText.substring(0, splitIndex).trim());
        currentText = currentText.substring(splitIndex).trim();
    }
    return messages.filter(m => m.length > 0);
}

// --- Slash Command Definitions ---
const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Make Son Goku active and ready to chat.')
        // Require the user to have the 'Manage Server' permission
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild), 
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Make Son Goku quiet and inactive.')
        // Require the user to have the 'Manage Server' permission
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild), 
    new SlashCommandBuilder()
        .setName('imagine')
        .setDescription('Generates an image from a prompt.')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('The text prompt to generate the image from.')
                .setRequired(true)),
].map(command => command.toJSON());

// --- Register Slash Commands ---
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Use a REST client to deploy the commands globally
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
    // serverId is used as a key for bot activity status and DB history
    const serverId = interaction.guildId || 'DM'; 
    const userId = user.id;

    await interaction.deferReply(); // Show "Bot is thinking..."

    switch (commandName) {
        case 'start':
            await setBotActiveStatus(serverId, true);
            await interaction.editReply(`Hi there, I'm Son Goku! I'm active and ready to chat. This command did **not** clear your history.`);
            break;

        case 'stop':
            await setBotActiveStatus(serverId, false);
            await interaction.editReply(`Gotta take a break! I'm now inactive and won't respond to messages until a moderator uses the /start command. Your context remains saved.`);
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
    // Ignore messages from bots or non-mention messages
    if (message.author.bot || !message.content.startsWith(`<@${client.user.id}>`)) return;

    const serverId = message.guildId || 'DM';
    const userId = message.author.id;
    const rawPrompt = message.content.replace(`<@${client.user.id}>`, '').trim();

    // Check bot's active status
    const isBotActive = await getBotActiveStatus(serverId);
    if (!isBotActive) return; // Do not respond if the bot is stopped

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
            filesToCleanup.push(file); 
        } catch (error) {
            console.error('Error processing attachment:', error);
            message.reply(`I had trouble processing the file: ${attachment.name}. I'll try to answer your text prompt without it.`);
            // Continue to the next attachment/text prompt
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
    }, 5000); 

    // 3. Retrieve Context (including personal context logic)
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
        const responseMessages = splitLongResponse(responseText);

        for (let i = 0; i < responseMessages.length; i++) {
            // First message is a reply, subsequent are simple sends
            if (i === 0) {
                await message.reply(responseMessages[i]);
            } else {
                await message.channel.send(responseMessages[i]);
            }
        }

        // 6. Save both user and model messages to history
        await saveMessage(serverId, userId, rawPrompt, 'user', fileParts.map(fp => ({
            mimeType: fp.fileData.mimeType,
            fileUri: fp.fileData.fileUri
        })));
        await saveMessage(serverId, userId, responseText, 'model');

    } catch (error) {
        console.error('Error sending Discord reply or saving message:', error);
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
    
