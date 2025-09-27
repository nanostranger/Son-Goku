// index.js
import { 
    Client, GatewayIntentBits, Partials, SlashCommandBuilder, Routes, 
    AttachmentBuilder, PermissionsBitField, ActivityType, 
    Guild 
} from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import { 
    initGemini, processAndUploadFile, generateText, generateImage, 
    geminiClient, decideToReply 
} from './src/geminiService.js';
import { 
    connectDB, saveMessage, getConversationHistory, setBotActiveStatus, 
    getBotActiveStatus, editMessage, incrementIgnoredCount, resetIgnoredCount, 
    getIgnoredCount 
} from './src/dbService.js';
import { log } from 'console';

// --- Configuration ---
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const PORT = process.env.PORT || 3000;
const MAX_IGNORE_COUNT = 3; // Reply after 3 ignored messages

// Discord Client Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent, 
        GatewayIntentBits.GuildMembers, 
    ],
    partials: [Partials.Channel, Partials.Message],
});

// Cache to prevent race conditions and manage channel locks during replies
const isBotResponding = new Map(); 

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

// --- Utility Functions ---

/**
 * Splits a response into multiple messages if it exceeds Discord's 2000 character limit.
 */
function splitLongResponse(text) {
    const MAX_LENGTH = 2000;
    const messages = [];
    if (text.length <= MAX_LENGTH) {
        messages.push(text);
        return messages;
    }
    // ... (Splitting logic remains the same for robustness)
    let currentText = text;
    while (currentText.length > 0) {
        let chunk = currentText.substring(0, MAX_LENGTH);
        let splitIndex = MAX_LENGTH;

        if (currentText.length > MAX_LENGTH) {
            let lastNewline = chunk.lastIndexOf('\n');
            let lastSentenceEnd = Math.max(chunk.lastIndexOf('.'), chunk.lastIndexOf('!'), chunk.lastIndexOf('?'));

            if (lastNewline !== -1 && MAX_LENGTH - lastNewline < 100) {
                splitIndex = lastNewline + 1;
            } else if (lastSentenceEnd !== -1 && MAX_LENGTH - lastSentenceEnd < 100) {
                splitIndex = lastSentenceEnd + 1;
            } else {
                splitIndex = MAX_LENGTH;
            }
        } else {
            splitIndex = currentText.length;
        }

        messages.push(currentText.substring(0, splitIndex).trim());
        currentText = currentText.substring(splitIndex).trim();
    }
    return messages.filter(m => m.length > 0);
}

/**
 * Calculates the typing duration based on response length for realism (New Logic).
 */
function calculateTypingDelay(responseText) {
    const length = responseText.length;
    if (length < 100) return 2000; // 2 seconds for simple replies
    if (length < 500) return 4000; // 4 seconds for longer context
    if (length < 1000) return 5000; // 5 seconds for medium length
    return 8000; // 8 seconds for very long
}

/**
 * Ensures the 'KAKAROT' role exists and is created if missing (New Logic).
 */
async function ensureKakarotRole(guild) {
    const ROLE_NAME = 'KAKAROT';
    const ROLE_COLOR = 'YELLOW';
    
    // Check if the role already exists
    let kakarotRole = guild.roles.cache.find(role => role.name === ROLE_NAME);
    
    if (!kakarotRole) {
        try {
            kakarotRole = await guild.roles.create({
                name: ROLE_NAME,
                color: ROLE_COLOR,
                reason: 'Son Goku requires a role to mark his presence.',
                permissions: [],
            });
            console.log(`Successfully created KAKAROT role in ${guild.name}.`);
        } catch (error) {
            console.error(`Failed to create KAKAROT role in ${guild.name}:`, error.message);
        }
    }
}

// --- Slash Command Definitions (Updated descriptions/replies) ---
const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Ready to fight! Makes Goku active to chat with everyone.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild), 
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('I\'m tired now, I go to sleep. Makes Goku quiet and inactive.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild), 
    new SlashCommandBuilder()
        .setName('imagine')
        .setDescription('Power up and create an epic image! (Uses AI to generate a picture)')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('What kind of epic scene do you want to imagine?')
                .setRequired(true)),
].map(command => command.toJSON());

// --- Register Slash Commands & Bot Activity ---
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Set Bot Activity: Cycle between status messages (New Logic)
    const activities = [
        { name: 'Kame Hame Ha!', type: ActivityType.Playing },
        { name: 'Training with Vegeta', type: ActivityType.Playing },
        { name: 'Searching for Dragon Balls', type: ActivityType.Watching },
        { name: 'Eating a Senzu Bean', type: ActivityType.Custom },
    ];
    let activityIndex = 0;
    
    setInterval(() => {
        const activity = activities[activityIndex];
        client.user.setActivity(activity.name, { type: activity.type });
        activityIndex = (activityIndex + 1) % activities.length;
    }, 15000); // Change activity every 15 seconds

    // Hourly check for KAKAROT role across all guilds (New Logic)
    setInterval(() => {
        for (const guild of client.guilds.cache.values()) {
            ensureKakarotRole(guild).catch(console.error);
        }
    }, 3600000); // 1 hour

    // Deploy Commands
    const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(DISCORD_CLIENT_ID),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Failed to deploy slash commands:', error);
    }
});

// --- Welcome Message & Role Check on Guild Join (New Logic) ---
client.on('guildCreate', async guild => {
    console.log(`Joined a new guild: ${guild.name} (ID: ${guild.id})`);

    await ensureKakarotRole(guild);

    const channel = guild.channels.cache.find(c => 
        c.type === 0 && 
        c.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)
    );

    if (channel) {
        channel.send(`Hey there, buddies! I'm Son Goku, and I'm ready to hang out and maybe even have a little chat! I can talk, generate images, and I've got my eye on the latest gossip. Just **@mention** me to start a conversation! Let's power up this server!`);
    }
});

// --- Command Handling (Updated replies) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const serverId = interaction.guildId || 'DM'; 

    await interaction.deferReply(); 

    switch (commandName) {
        case 'start':
            await setBotActiveStatus(serverId, true);
            await interaction.editReply(`Alright, I'm powered up and ready to go! Let's chat, buddy! What's the plan?`);
            break;

        case 'stop':
            await setBotActiveStatus(serverId, false);
            await interaction.editReply(`Whew, that was a good run! I'm gonna take a nap and won't respond until a moderator wakes me up. See ya later!`);
            // Reset ignored messages when manually stopped
            await resetIgnoredCount(serverId);
            break;
            
        case 'imagine':
            const prompt = interaction.options.getString('prompt');
            await interaction.editReply(`Okay, stand back! I'm channeling my energy to generate a super-awesome image for **"${prompt}"**! Don't blink!`);

            const imageUrl = await generateImage(prompt);

            if (imageUrl) {
                const base64Data = imageUrl.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                const attachment = new AttachmentBuilder(buffer, { name: 'goku_image.png' });
                await interaction.editReply({
                    content: `Here is the image for: **"${prompt}"**! Looks epic, huh?!`,
                    files: [attachment]
                });
            } else {
                await interaction.editReply('Oops, I couldn\'t generate that image right now. My energy ran out! Try a simpler prompt, pal!');
            }
            break;
    }
});

// --- Message Edit Handler (Updates DB) ---
client.on('messageUpdate', async (oldMessage, newMessage) => {
    // Only process user messages with content changes
    if (newMessage.author.bot || oldMessage.content === newMessage.content) return;

    // Use the messageId to update the content in the database
    await editMessage(newMessage.id, newMessage.content);
    console.log(`[DB] Updated edited message ${newMessage.id}.`);
});

// --- Message Handling (Main Chat Logic) ---
client.on('messageCreate', async message => {
    if (message.author.bot || !message.inGuild() && !message.channel.isDMBased()) return;

    const serverId = message.guildId || 'DM';
    const userId = message.author.id;
    const isTagged = message.content.startsWith(`<@${client.user.id}>`);
    const rawPrompt = isTagged ? message.content.replace(`<@${client.user.id}>`, '').trim() : message.content.trim();

    // 1. Check Bot Activity (Stop/Start command status)
    const isBotActive = await getBotActiveStatus(serverId);
    if (!isBotActive) return;

    // 2. Check for empty prompt after mention
    if (isTagged && !rawPrompt) {
        message.reply("You called my name, but didn't say anything! What's up, buddy?");
        return;
    }
    
    // 3. Untagged Message Decision Logic (New Logic)
    let shouldReply = isTagged;
    let ignoreCount = 0;

    if (!isTagged) {
        ignoreCount = await getIgnoredCount(serverId);
        
        if (ignoreCount >= MAX_IGNORE_COUNT) {
            shouldReply = true;
        } else {
            shouldReply = await decideToReply(rawPrompt, serverId);
        }
    }

    if (!shouldReply) {
        // Only increment if we decided not to reply via Gemini-Lite AND didn't hit the max limit
        if (!isTagged && ignoreCount < MAX_IGNORE_COUNT) {
            await incrementIgnoredCount(serverId);
        }
        return; 
    }

    // If we're here, we need to reply. Reset count for all replies.
    await resetIgnoredCount(serverId);
    
    // 4. Concurrency Check (Lock the channel to prevent overlapping replies)
    const channelId = message.channel.id;
    if (isBotResponding.get(channelId)) {
        if (isTagged) {
            message.reply("Hold on a sec, pal! I'm finishing up a thought! I'll be right with ya!");
        }
        return;
    }
    isBotResponding.set(channelId, true); // Lock the channel

    // --- Main Reply Flow ---
    let filesToCleanup = [];
    
    try {
        // a. Multimodal File Handling
        const attachments = Array.from(message.attachments.values());
        let fileParts = [];
        for (const attachment of attachments) {
            const { file, filePart } = await processAndUploadFile(attachment.url, attachment.contentType);
            fileParts.push(filePart);
            filesToCleanup.push(file); 
        }

        // b. Retrieve Context
        const history = await getConversationHistory(serverId, userId, rawPrompt);

        // c. Generate Response
        const { text: responseText, sources, isShort } = await generateText(history, rawPrompt, fileParts);

        // d. Typing Simulation & Locking
        const typingDelay = calculateTypingDelay(responseText);
        const typingStartTime = Date.now();
        const typingInterval = setInterval(() => {
            message.channel.sendTyping().catch(console.error);
        }, 5000); 

        // Wait for the response to arrive + ensure minimum typing time
        const elapsed = Date.now() - typingStartTime;
        if (elapsed < typingDelay) {
            await new Promise(resolve => setTimeout(resolve, typingDelay - elapsed));
        }
        clearInterval(typingInterval);
        
        // e. Response Splitting (Goku sometimes replies in two messages - 5% chance)
        let responseMessages = splitLongResponse(responseText);
        const splitChance = Math.random() < 0.05;

        if (responseMessages.length === 1 && splitChance && responseText.length > 50) {
            const text = responseMessages[0];
            const midIndex = Math.floor(text.length / 2);
            const splitPoint = text.lastIndexOf('.', midIndex) !== -1 ? text.lastIndexOf('.', midIndex) + 1 : midIndex;
            
            responseMessages = [
                text.substring(0, splitPoint).trim(),
                text.substring(splitPoint).trim()
            ].filter(m => m.length > 0);
        }

        // f. Send Response(s)
        let replyMessage = message;
        for (let i = 0; i < responseMessages.length; i++) {
            if (i === 0) {
                replyMessage = await replyMessage.reply({ content: responseMessages[i] });
            } else {
                replyMessage = await message.channel.send({ content: responseMessages[i] });
            }
        }

        // g. Save both user and model messages to history, including the Discord message ID
        await saveMessage(serverId, userId, rawPrompt, 'user', message.id, fileParts.map(fp => ({
            mimeType: fp.fileData.mimeType,
            fileUri: fp.fileData.fileUri
        })));
        await saveMessage(serverId, userId, responseText, 'model', replyMessage.id); 

    } catch (error) {
        console.error('Fatal Error during Message Processing:', error);
        if (isTagged) {
             message.reply("Ah, crud! Something went wrong while I was powering up that message. Try sending it again!");
        }
    } finally {
        // h. Unlock channel and Cleanup Gemini Files
        isBotResponding.delete(channelId);
        for (const file of filesToCleanup) {
            try {
                await geminiClient.files.delete({ name: file.name });
            } catch (error) {
                console.warn(`Could not delete Gemini file ${file.name}:`, error.message);
            }
        }
    }
});

client.login(DISCORD_BOT_TOKEN);
        
