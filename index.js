// index.js
import { 
    Client, GatewayIntentBits, Partials, SlashCommandBuilder, Routes, 
    AttachmentBuilder, PermissionsBitField, ActivityType, 
    Collection 
} from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import { 
    initGemini, processAndUploadFile, generateText, generateImage, 
    editImage, decideToReply, geminiClient
} from './src/geminiService.js';
import { 
    connectDB, saveMessage, getConversationHistory, setBotActiveStatus, 
    getBotActiveStatus, editMessage, incrementIgnoredCount, resetIgnoredCount, 
    getIgnoredCount, setContinuousReplyStatus, getContinuousReplyStatus, 
    checkAndIncrementImageUsage 
} from './src/dbService.js';
import { log } from 'console';

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const PORT = process.env.PORT || 3000;
const MAX_IGNORE_COUNT = 1;

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

const isBotResponding = new Map(); 
const activeDrawInteractions = new Collection(); 

connectDB();
try {
    initGemini();
} catch (e) {
    log(e.message);
    process.exit(1);
}

const app = express();
app.get('/', (req, res) => res.send('Son Goku Bot is running!'));
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

function splitLongResponse(text) {
    const MAX_LENGTH = 2000;
    const messages = [];
    if (text.length <= MAX_LENGTH) {
        messages.push(text);
        return messages;
    }
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

function calculateTypingDelay(responseText) {
    const length = responseText.length;
    if (length < 100) return 2000; 
    return 5000; 
}

async function ensureKakarotRole(guild) {
    const ROLE_NAME = 'KAKAROT';
    const ROLE_COLOR = 'YELLOW';
    
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

const GOKU_ACTIVITIES = [
    { name: 'Kame Hame Ha!', type: ActivityType.Playing },
    { name: 'Training with Vegeta', type: ActivityType.Playing },
    { name: 'Searching for Dragon Balls', type: ActivityType.Watching },
    { name: 'Eating a Senzu Bean', type: ActivityType.Custom },
    { name: 'Instant Transmission practice', type: ActivityType.Playing },
    { name: 'Waiting for the next tournament', type: ActivityType.Watching },
    { name: 'Powering up to Super Saiyan', type: ActivityType.Playing },
    { name: 'Trying to catch Bubbles', type: ActivityType.Playing },
    { name: 'Learning the Kaioken', type: ActivityType.Playing },
    { name: 'Fighting Frieza', type: ActivityType.Playing },
    { name: 'Eating 50 bowls of rice', type: ActivityType.Custom },
    { name: 'Charging a Spirit Bomb', type: ActivityType.Playing },
    { name: 'Chasing after Krillin', type: ActivityType.Watching },
    { name: 'Visiting King Kai', type: ActivityType.Listening },
    { name: 'Napping with Gohan', type: ActivityType.Playing },
    { name: 'Looking for a giant meal', type: ActivityType.Watching },
    { name: 'Meditating on Namek', type: ActivityType.Listening },
    { name: 'Sparring with Piccolo', type: ActivityType.Playing },
    { name: 'Defending Earth', type: ActivityType.Playing },
    { name: 'Mastering Ultra Instinct', type: ActivityType.Playing },
    { name: 'Looking for Chi-Chi', type: ActivityType.Watching },
    { name: 'Driving a car (badly)', type: ActivityType.Playing },
    { name: 'Doing push-ups in 100x gravity', type: ActivityType.Playing },
    { name: 'Eating a giant fish', type: ActivityType.Custom },
    { name: 'Fighting Beerus', type: ActivityType.Playing },
    { name: 'Counting his strength', type: ActivityType.Watching },
    { name: 'Testing his limits', type: ActivityType.Playing },
    { name: 'Looking for a new rival', type: ActivityType.Watching },
    { name: 'Listening to Bulma complain', type: ActivityType.Listening },
    { name: 'Trying to understand girls', type: ActivityType.Custom },
    { name: 'Practicing the Destructo Disk', type: ActivityType.Playing },
    { name: 'Watching Hercule lose', type: ActivityType.Watching },
    { name: 'Talking to Shenron', type: ActivityType.Watching },
    { name: 'Making new friends', type: ActivityType.Playing },
    { name: 'Getting yelled at by Chi-Chi', type: ActivityType.Listening },
    { name: 'Training Goten', type: ActivityType.Playing },
    { name: 'Visiting Kami’s Lookout', type: ActivityType.Listening },
    { name: 'Challenging Whis', type: ActivityType.Playing },
    { name: 'Powering down for a snack', type: ActivityType.Custom },
    { name: 'Waiting for Vegeta to cool off', type: ActivityType.Watching },
    { name: 'Practicing Fusion Dance', type: ActivityType.Playing },
    { name: 'Eating all the food in the fridge', type: ActivityType.Custom },
    { name: 'Punching mountains', type: ActivityType.Playing },
    { name: 'Traveling to other planets', type: ActivityType.Watching },
    { name: 'Looking for a worthy opponent', type: ActivityType.Watching },
    { name: 'Doing warm-ups', type: ActivityType.Playing },
    { name: 'Getting a new Gi', type: ActivityType.Custom },
    { name: 'Flying around the world', type: ActivityType.Playing },
    { name: 'Talking about fighting', type: ActivityType.Listening },
    { name: 'Fighting Cell', type: ActivityType.Playing },
];

const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Ready to fight! Makes Goku active to chat with everyone.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .toJSON(),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('I\'m tired now, I go to sleep. Makes Goku quiet and inactive.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .toJSON(),
    new SlashCommandBuilder()
        .setName('imagine')
        .setDescription('Power up and create an epic image! (5 uses/day)')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('What kind of epic scene do you want to imagine?')
                .setRequired(true))
        .toJSON(),
    new SlashCommandBuilder() 
        .setName('draw')
        .setDescription('Wanna make changes to an image? Give me a picture and tell me what to do! (5 uses/day)')
        .toJSON(),
    new SlashCommandBuilder() 
        .setName('reply')
        .setDescription('Tell Goku to continuously chat or take a break from untagged messages.')
        .addStringOption(option =>
            option.setName('mode')
                .setDescription('Should Goku continuously reply to you or only when mentioned?')
                .setRequired(true)
                .addChoices(
                    { name: 'on (Chat continuously)', value: 'on' },
                    { name: 'off (Only reply when mentioned)', value: 'off' }
                ))
        .toJSON(),
];

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    function setRandomActivity() {
        const activity = GOKU_ACTIVITIES[Math.floor(Math.random() * GOKU_ACTIVITIES.length)];
        client.user.setActivity(activity.name, { type: activity.type });
    }
    
    setRandomActivity();
    setInterval(setRandomActivity, 3600000); 

    setInterval(() => {
        for (const guild of client.guilds.cache.values()) {
            ensureKakarotRole(guild).catch(console.error);
        }
    }, 3600000); 

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

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, user, channelId, channel } = interaction;
    const serverId = interaction.guildId || 'DM'; 

    if (activeDrawInteractions.has(user.id) && commandName !== 'draw') {
        await interaction.reply({ content: "Whoa, hold on! You're already powering up a `/draw` command! Finish that one before starting a new one, pal!", ephemeral: true });
        return;
    }
    
    await interaction.deferReply(); 

    switch (commandName) {
        case 'start':
            await setBotActiveStatus(serverId, true);
            await interaction.editReply(`Alright, I'm powered up and ready to go! Let's chat, buddy! What's the plan?`);
            break;

        case 'stop':
            await setBotActiveStatus(serverId, false);
            await interaction.editReply(`Whew, that was a good run! I'm gonna take a nap and won't respond until a moderator wakes me up. See ya later!`);
            await resetIgnoredCount(serverId);
            break;
            
        case 'imagine':
        case 'draw': 
            const usageResult = await checkAndIncrementImageUsage(user.id);
            if (!usageResult.allowed) {
                return interaction.editReply(`My energy for drawing is all used up for today! I can only do 5 image creations per day, pal. I've already done **${usageResult.count}**! Come back tomorrow!`);
            }

            if (commandName === 'imagine') {
                const prompt = interaction.options.getString('prompt');
                await interaction.editReply(`Okay, stand back! I'm channeling my energy to generate a super-awesome image for **"${prompt}"**! Don't blink!`);

                const imageUrl = await generateImage(prompt);
                
                if (imageUrl) {
                    const base64Data = imageUrl.split(',')[1];
                    const buffer = Buffer.from(base64Data, 'base64');
                    const attachment = new AttachmentBuilder(buffer, { name: 'goku_image.png' });
                    await interaction.editReply({
                        content: `Here is the image for: **"${prompt}"**! Looks epic, huh?! You have **${5 - usageResult.count}** uses left today!`,
                        files: [attachment]
                    });
                } else {
                    await interaction.editReply('Oops, I couldn\'t generate that image right now. My energy ran out! Try a simpler prompt, pal!');
                }
            } else { 
                const initialReply = await interaction.editReply(`Alright, I can power up your image! **Reply to this message with the picture you want to change within 30 seconds!**`);
                activeDrawInteractions.set(user.id, { step: 'image' });

                try {
                    const imageCollector = channel.createMessageCollector({
                        filter: m => m.author.id === user.id && m.attachments.size > 0 && activeDrawInteractions.get(user.id)?.step === 'image',
                        time: 30000, max: 1
                    });

                    const collectedImage = await new Promise((resolve, reject) => {
                        imageCollector.on('collect', m => resolve(m));
                        imageCollector.on('end', collected => {
                            if (collected.size === 0) reject(new Error('timeout_image'));
                        });
                    });

                    if (!collectedImage) throw new Error('no_image');

                    const attachment = collectedImage.attachments.first();
                    if (!attachment.contentType || !attachment.contentType.startsWith('image')) {
                        throw new Error('not_image');
                    }

                    const { file: geminiFile, filePart: imagePart } = await processAndUploadFile(attachment.url, attachment.contentType);
                    
                    await initialReply.edit(`Awesome! Now tell me, **what changes should I make to this picture?** (You have 30 seconds)`);
                    activeDrawInteractions.set(user.id, { step: 'prompt', file: geminiFile, imagePart: imagePart });

                    const promptCollector = channel.createMessageCollector({
                        filter: m => m.author.id === user.id && m.content && activeDrawInteractions.get(user.id)?.step === 'prompt',
                        time: 30000, max: 1
                    });
                    
                    const collectedPrompt = await new Promise((resolve, reject) => {
                        promptCollector.on('collect', m => resolve(m));
                        promptCollector.on('end', collected => {
                            if (collected.size === 0) reject(new Error('timeout_prompt'));
                        });
                    });

                    if (!collectedPrompt) throw new Error('no_prompt');

                    const promptText = collectedPrompt.content;

                    await initialReply.edit(`Powering up... **Drawing the changes for you!** Hold tight!`);

                    const editedImageUrl = await editImage(imagePart, promptText);

                    if (editedImageUrl) {
                        const base64Data = editedImageUrl.split(',')[1];
                        const buffer = Buffer.from(base64Data, 'base64');
                        const imageAttachment = new AttachmentBuilder(buffer, { name: 'goku_edited_image.png' });
                        
                        await initialReply.edit({
                            content: `**TADA!** Here’s the updated picture based on your command: **"${promptText}"**! Did I get stronger?! You have **${5 - usageResult.count}** uses left today!`,
                            files: [imageAttachment]
                        });
                    } else {
                        await initialReply.edit('Uh oh, I couldn\'t figure out how to draw that change! My power levels dropped. Try a simpler change, pal!');
                    }

                } catch (error) {
                    let errorMessage;
                    if (error.message === 'timeout_image') {
                        errorMessage = "Time's up! You didn't give me an image fast enough. Next time, move quicker, buddy!";
                    } else if (error.message === 'timeout_prompt') {
                        errorMessage = "Time's up! I need the change prompt right away! Let's try again with `/draw`.";
                    } else if (error.message === 'not_image') {
                        errorMessage = "That wasn't a picture! Try again with an actual image file.";
                    } else {
                        console.error('Fatal /draw flow error:', error);
                        errorMessage = "Oh no, something went wrong with the process! Let's start over with `/draw`.";
                    }
                    await initialReply.edit(errorMessage).catch(e => console.error("Error editing final /draw reply:", e.message));

                } finally {
                    activeDrawInteractions.delete(user.id);
                    const interactionData = activeDrawInteractions.get(user.id);
                    if (interactionData && interactionData.file) {
                        try {
                            await geminiClient.files.delete({ name: interactionData.file.name });
                        } catch (e) {
                            console.warn('Failed to clean up Gemini file after /draw:', e.message);
                        }
                    }
                }
            }
            break;
            
        case 'reply': 
            const mode = interaction.options.getString('mode');
            const isActive = mode === 'on';
            await setContinuousReplyStatus(user.id, isActive);
            
            if (isActive) {
                await interaction.editReply(`YAY! Continuous chat **ON**! I'll talk to you a lot more now, buddy! Let's keep the conversation going!`);
            } else {
                await interaction.editReply(`Okay, continuous chat **OFF**. I'll only reply when you **@mention** me now. I need to save my energy for snacks!`);
            }
            break;
    }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (newMessage.author.bot || oldMessage.content === newMessage.content) return;
    await editMessage(newMessage.id, newMessage.content);
    console.log(`[DB] Updated edited message ${newMessage.id}.`);
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.inGuild() && !message.channel.isDMBased()) return;

    const serverId = message.guildId || 'DM';
    const userId = message.author.id;
    const guildName = message.guild ? message.guild.name : 'DM';
    const isTagged = message.mentions.users.first()?.id === client.user.id;
    const isReplyToBot = message.reference && message.reference.messageId 
        ? (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author.id === client.user.id
        : false;
    
    const isMandatoryPingReply = isTagged || isReplyToBot;
    
    const rawPrompt = isTagged ? message.content.replace(`<@${client.user.id}>`, '').trim() : message.content.trim();
    
    const formattedPrompt = `[${guildName}/${userId}] ${rawPrompt}`;

    if (activeDrawInteractions.has(userId)) return;
    const isBotActive = await getBotActiveStatus(serverId);
    if (!isBotActive) return;

    let shouldReply = isMandatoryPingReply;
    
    if (!shouldReply) {
        const isContinuous = await getContinuousReplyStatus(userId);
        let ignoreCount = await getIgnoredCount(serverId);

        if (isContinuous) {
            shouldReply = true;
        } else if (ignoreCount >= MAX_IGNORE_COUNT) {
            shouldReply = true;
        } else {
            shouldReply = await decideToReply(rawPrompt, serverId);
        }
    }

    if (!shouldReply) {
        if (!isMandatoryPingReply) {
            await incrementIgnoredCount(serverId);
        }
        return; 
    }

    await resetIgnoredCount(serverId);
    
    const channelId = message.channel.id;
    if (isBotResponding.get(channelId)) {
        if (isMandatoryPingReply) {
            message.reply({ content: "Hold on a sec, pal! I'm finishing up a thought! I'll be right with ya!", allowedMentions: { repliedUser: false }});
        }
        return;
    }
    isBotResponding.set(channelId, true); 

    let filesToCleanup = [];
    
    try {
        const attachments = Array.from(message.attachments.values());
        let fileParts = [];
        for (const attachment of attachments) {
            const { file, filePart } = await processAndUploadFile(attachment.url, attachment.contentType);
            fileParts.push(filePart);
            filesToCleanup.push(file); 
        }

        const history = await getConversationHistory(serverId, userId, rawPrompt);

        const { text: responseText, sources, isShort } = await generateText(history, formattedPrompt, fileParts);

        const typingDelay = calculateTypingDelay(responseText);
        const typingStartTime = Date.now();
        
        await message.channel.sendTyping().catch(console.error); 
        const typingInterval = setInterval(() => {
            message.channel.sendTyping().catch(console.error);
        }, 5000); 

        const elapsed = Date.now() - typingStartTime;
        if (elapsed < typingDelay) {
            await new Promise(resolve => setTimeout(resolve, typingDelay - elapsed));
        }
        clearInterval(typingInterval);
        
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

        let replyMessage;
        const replyOptions = { content: responseMessages[0] };
        
        if (isMandatoryPingReply) {
            replyMessage = await message.reply(replyOptions);
        } else {
             replyOptions.reply = { messageReference: message.id, failIfNotExists: false };
             replyOptions.allowedMentions = { repliedUser: false };
             replyMessage = await message.channel.send(replyOptions);
        }
        
        for (let i = 1; i < responseMessages.length; i++) {
            await message.channel.send({ content: responseMessages[i] });
        }

        await saveMessage(serverId, userId, rawPrompt, 'user', message.id, fileParts.map(fp => ({
            mimeType: fp.fileData.mimeType,
            fileUri: fp.fileData.fileUri
        })));
        await saveMessage(serverId, userId, responseText, 'model', replyMessage.id); 

    } catch (error) {
        console.error('Fatal Error during Message Processing:', error);
        if (isMandatoryPingReply) {
             message.reply({ content: "Ah, crud! Something went wrong while I was powering up that message. Try sending it again!", allowedMentions: { repliedUser: false }});
        }
    } finally {
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
