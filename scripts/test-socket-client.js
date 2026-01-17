#!/usr/bin/env node

/**
 * Socket Client Test Script
 * 
 * Connects to the Phoenix socket server and can join either:
 * - Conversation room: for specific conversation messages (requires client-id and user-identifier)
 * - Agent room: for all conversation updates for an agent (no client-id/user-identifier needed)
 * 
 * Usage:
 *   node scripts/test-socket-client.js [options]
 * 
 * Options:
 *   --socket-url       Socket server URL (default: ws://localhost:3003/socket)
 *   --token            JWT token (if not provided, will generate one)
 *   --agent-room       Join agent room instead of conversation room (for conversation list updates)
 *   --client-id        Client ID for joining conversation (required for conversation room)
 *   --user-identifier  User identifier (customer phone) for joining conversation (required for conversation room)
 *   --agent-code       Agent code for JWT token generation (default: from env or 'test-agent')
 *   --send-message     Send a message after joining (requires --content)
 *   --content          Message content to send (required with --send-message)
 *   --message-type     Message type (default: 'text')
 *   --conversation-id  Conversation ID (hashed_id) for sending message (optional, will be calculated if not provided)
 */

require('dotenv/config');
const { Socket } = require('phoenix');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    socketUrl: process.env.SOCKET_SERVER_URL || 'ws://localhost:3003/socket',
    token: null,
    agentRoom: false,
    clientId: null,
    userIdentifier: null,
    agentCode: process.env.AGENT_CODE || 'test-agent',
    platform: 'wpp', // Default to 'wpp', can be 'wpp' or 'wa-official'
    sendMessage: false,
    content: null,
    messageType: 'text',
    conversationId: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--socket-url':
      case '-s':
        config.socketUrl = nextArg;
        i++;
        break;
      case '--token':
      case '-t':
        config.token = nextArg;
        i++;
        break;
      case '--agent-room':
      case '--agent':
        config.agentRoom = true;
        break;
      case '--client-id':
      case '-c':
        config.clientId = nextArg;
        i++;
        break;
      case '--user-identifier':
      case '-i':
        config.userIdentifier = nextArg;
        i++;
        break;
      case '--agent-code':
      case '-a':
        config.agentCode = nextArg;
        i++;
        break;
      case '--platform':
      case '-p':
        config.platform = nextArg;
        i++;
        break;
      case '--send-message':
      case '--send':
        config.sendMessage = true;
        break;
      case '--content':
      case '-m':
        config.content = nextArg;
        i++;
        break;
      case '--message-type':
        config.messageType = nextArg;
        i++;
        break;
      case '--conversation-id':
      case '--conv-id':
        config.conversationId = nextArg;
        i++;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: node scripts/test-socket-client.js [options]

Modes:
  Conversation Room (default): Join a specific conversation room
  Agent Room: Join agent room for all conversation updates (use --agent-room flag)

Options:
  --socket-url, -s      Socket server URL (default: ws://localhost:3003/socket)
  --token, -t           JWT token (if not provided, will generate one)
  --agent-room, --agent Join agent room instead of conversation room
  --client-id, -c       Client ID for joining conversation (required for conversation room)
  --user-identifier, -i  User identifier (customer phone) for joining conversation (required for conversation room)
  --agent-code, -a      Agent code for JWT token generation (default: test-agent)
  --platform, -p        Platform type: 'wpp' or 'wa-official' (default: 'wpp')
  --send-message, --send  Send a message after joining (requires --content)
  --content, -m         Message content to send (required with --send-message)
  --message-type        Message type (default: 'text')
  --conversation-id, --conv-id  Conversation ID (hashed_id) for sending message (optional, will be calculated if not provided)
  --help, -h            Show this help message

Examples:
  # Test conversation room (specific conversation)
  node scripts/test-socket-client.js --client-id cs-gue --user-identifier 6282121547121
  npm run test-socket -- --client-id cs-gue --user-identifier 6282121547121

  # Test agent room (all conversation updates)
  node scripts/test-socket-client.js --agent-room --agent-code Herbakof
  npm run test-socket -- --agent-room --agent-code Herbakof

  # Send a message via socket (WPP)
  node scripts/test-socket-client.js --client-id cs-gue --user-identifier 6282121547121 --send-message --content "Hello from socket!"
  npm run test-socket -- --client-id cs-gue --user-identifier 6282121547121 --send-message --content "Hello!"

  # Send a message via socket (WA-Official)
  node scripts/test-socket-client.js --client-id wa-client --user-identifier 6282121547121 --platform wa-official --send-message --content "Hello!"
        `);
        process.exit(0);
        break;
    }
  }

  return config;
}

// Generate JWT token if not provided
function generateToken(agentCode) {
  // WA_JWT_SECRET is the single source of truth for JWT secret
  const jwtSecret = process.env.WA_JWT_SECRET;
  
  if (!jwtSecret) {
    console.error('❌ WA_JWT_SECRET environment variable is required');
    console.error('   Please set WA_JWT_SECRET in your .env file or use --token option');
    process.exit(1);
  }

  const payload = {
    sub: `test-user-${Date.now()}`,
    agentCode: agentCode,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hours
  };

  return jwt.sign(payload, jwtSecret);
}

// Hash room ID using HMAC-SHA256 (matches Elixir implementation)
function hashRoomId(agentCode, clientId, userIdentifier) {
  const secret = process.env.ROOM_HASH_SECRET;
  
  if (!secret) {
    throw new Error('ROOM_HASH_SECRET environment variable is required for room hashing');
  }
  
  // Construct input: "agentCode:clientId:userIdentifier"
  const input = `${agentCode}:${clientId}:${userIdentifier}`;
  
  // Hash using HMAC-SHA256
  const hash = crypto.createHmac('sha256', secret).update(input).digest('base64');
  
  return hash;
}

// Format timestamp for logging
function formatTime() {
  return new Date().toISOString();
}

// Format message content
function formatContent(content) {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.map(msg => {
        if (msg.type === 'text') {
          return msg.text;
        }
        return JSON.stringify(msg);
      }).join('\n');
    }
    return JSON.stringify(parsed, null, 2);
  } catch (e) {
    return content;
  }
}

// Format event type with emoji
function formatEventType(eventType) {
  const emojis = {
    'message:incoming': '📥',
    'ai:response': '🤖',
    'agent:response': '👤',
    'message:outgoing': '📤'
  };
  return `${emojis[eventType] || '📨'} ${eventType}`;
}

// Main function
async function main() {
  const config = parseArgs();

  // Validate required parameters based on mode
  if (!config.agentRoom) {
    // Conversation room mode - requires client-id and user-identifier
    if (!config.clientId) {
      console.error('❌ --client-id is required for conversation room');
      console.error('   Usage: node scripts/test-socket-client.js --client-id cs-gue --user-identifier 6282121547121');
      console.error('   Or use --agent-room to join agent room instead');
      process.exit(1);
    }

    if (!config.userIdentifier) {
      console.error('❌ --user-identifier is required for conversation room');
      console.error('   Usage: node scripts/test-socket-client.js --client-id cs-gue --user-identifier 6282121547121');
      console.error('   Or use --agent-room to join agent room instead');
      process.exit(1);
    }
  }

  // Validate send message options
  if (config.sendMessage) {
    if (config.agentRoom) {
      console.error('❌ --send-message can only be used with conversation room (not agent room)');
      console.error('   You must provide --client-id and --user-identifier to send messages');
      process.exit(1);
    }

    if (!config.content) {
      console.error('❌ --content is required when using --send-message');
      console.error('   Usage: node scripts/test-socket-client.js --client-id cs-gue --user-identifier 6282121547121 --send-message --content "Hello!"');
      process.exit(1);
    }

    // Calculate or validate conversationId
    // The socket server validates conversationId against the agentCode in JWT
    try {
      const calculatedId = hashRoomId(config.agentCode, config.clientId, config.userIdentifier);
      
      if (config.conversationId) {
        // User provided a specific conversationId - validate it matches
        if (config.conversationId !== calculatedId) {
          console.warn(`⚠️  Warning: Provided conversationId doesn't match calculated one for agentCode "${config.agentCode}"`);
          console.warn(`   Provided: ${config.conversationId}`);
          console.warn(`   Calculated: ${calculatedId}`);
          console.warn(`   The socket server will reject this if agentCode doesn't match!`);
          console.warn(`   Make sure the agentCode in JWT matches the one used to calculate the provided conversationId.`);
          console.warn(`   Using provided conversationId: ${config.conversationId}`);
        } else {
          console.log(`ℹ️  Provided conversationId matches calculated one ✓`);
          console.log(`   Using conversationId: ${config.conversationId}`);
        }
      } else {
        // Auto-calculate conversationId
        config.conversationId = calculatedId;
        console.log(`ℹ️  Using conversationId (hashed_id): ${config.conversationId}`);
        console.log(`   (Calculated from agentCode: ${config.agentCode}, clientId: ${config.clientId}, userIdentifier: ${config.userIdentifier})`);
      }
    } catch (error) {
      console.error(`❌ Failed to calculate/validate conversationId: ${error.message}`);
      console.error('   Please set ROOM_HASH_SECRET environment variable');
      process.exit(1);
    }
  }

  // Generate or use provided token
  const token = config.token || generateToken(config.agentCode);
  
  console.log('🚀 Socket Client Test Script');
  console.log('============================');
  console.log(`📡 Socket URL: ${config.socketUrl}`);
  console.log(`🔑 Agent Code: ${config.agentCode}`);
  console.log(`🔐 Token: ${config.token ? 'Provided' : 'Generated'}`);
  console.log(`📋 Mode: ${config.agentRoom ? 'Agent Room (all conversation updates)' : 'Conversation Room (specific conversation)'}`);
  if (!config.agentRoom) {
    console.log(`👤 Client ID: ${config.clientId}`);
    console.log(`📱 User Identifier: ${config.userIdentifier}`);
    console.log(`🔧 Platform: ${config.platform}`);
    if (config.conversationId) {
      console.log(`🔑 Conversation ID: ${config.conversationId}`);
    }
  }
  if (config.sendMessage) {
    console.log(`📤 Send Message: Yes`);
    console.log(`   Content: ${config.content}`);
    console.log(`   Message Type: ${config.messageType}`);
  }
  console.log('');

  // Create socket connection
  const socket = new Socket(config.socketUrl, {
    params: { token },
    logger: (kind, msg, data) => {
      // Log all important events for debugging
      if (kind === 'error' || kind === 'close' || kind === 'open' || kind === 'connect') {
        console.log(`[${formatTime()}] Socket ${kind}: ${msg}`, data || '');
      }
    },
    reconnectAfterMs: (tries) => {
      console.log(`🔄 [${formatTime()}] Attempting to reconnect (attempt ${tries})...`);
      return [1000, 2000, 5000][tries - 1] || 5000;
    }
  });

  // Handle connection events
  socket.onOpen(() => {
    console.log(`✅ [${formatTime()}] Socket connected successfully`);
  });

  socket.onClose((event) => {
    console.log(`🔌 [${formatTime()}] Socket closed`);
    if (event && event.code) {
      console.log(`   Close code: ${event.code}`);
      console.log(`   Close reason: ${event.reason || 'No reason provided'}`);
    }
  });

  socket.onError((error) => {
    console.error(`❌ [${formatTime()}] Socket error:`, error);
    if (error.message) {
      console.error(`   Error message: ${error.message}`);
    }
    if (error.reason) {
      console.error(`   Reason: ${error.reason}`);
    }
    if (error.target && error.target.url) {
      console.error(`   Failed URL: ${error.target.url}`);
    }
    console.error(`   Socket URL: ${config.socketUrl}`);
    console.error('');
    console.error('💡 Troubleshooting:');
    console.error('   1. Check if the socket server is running');
    console.error('   2. Verify the socket URL is correct (should be ws:// or wss://)');
    console.error('   3. Check if the server allows WebSocket connections');
    console.error('   4. For Railway deployments, ensure public networking is enabled');
    console.error('   5. Try testing with a local server first: ws://localhost:3003/socket');
  });

  // Connect to socket
  console.log(`🔌 [${formatTime()}] Connecting to socket server...`);
  socket.connect();

  // Wait a bit for connection to establish (increase timeout for remote connections)
  const connectionTimeout = config.socketUrl.includes('localhost') ? 2000 : 5000;
  await new Promise(resolve => setTimeout(resolve, connectionTimeout));
  
  // Check if connection was successful
  if (!socket.isConnected()) {
    console.error(`❌ [${formatTime()}] Connection failed - socket not connected after ${connectionTimeout}ms`);
    console.error(`   Socket URL: ${config.socketUrl}`);
    console.error('');
    console.error('💡 Possible issues:');
    console.error('   1. Socket server is not running or not accessible');
    console.error('   2. URL is incorrect (check protocol: ws:// or wss://)');
    console.error('   3. Network/firewall blocking the connection');
    console.error('   4. For Railway: ensure public networking is enabled for the socket-server service');
    console.error('   5. SSL/TLS certificate issue (if using wss://)');
    console.error('');
    console.error('   Try testing locally first:');
    console.error('   npm run test-socket -- --agent-room --agent-code Herbakof --socket-url ws://localhost:3003/socket');
    process.exit(1);
  }

  let channel;
  let channelName;
  let channelPayload = {};

  if (config.agentRoom) {
    // Join agent channel (no payload needed - agentCode from JWT)
    channelName = 'agent';
    channel = socket.channel(channelName, {});
  } else {
    // Join conversation channel
    channelName = 'conversation';
    channelPayload = {
      client_id: config.clientId,
      user_identifier: config.userIdentifier,
      platform: config.platform // Include platform for routing to correct consumer
    };
    channel = socket.channel(channelName, channelPayload);
  }

  // Handle channel join
  channel.join()
    .receive('ok', (resp) => {
      const roomType = config.agentRoom ? 'agent room' : 'conversation room';
      console.log(`✅ [${formatTime()}] Joined ${roomType} successfully`);
      console.log(`   Response:`, JSON.stringify(resp, null, 2));
      console.log('');
      if (config.agentRoom) {
        console.log('👂 Listening for conversation updates...');
        console.log('   You will receive updates for ALL conversations belonging to this agent');
        console.log('   Use this to update conversation list in real-time');
      } else {
        console.log('👂 Listening for messages...');
      }
      console.log('   (Press Ctrl+C to exit)');
      console.log('');

      // Send message if requested
      if (config.sendMessage && !config.agentRoom) {
        setTimeout(() => {
          sendMessage(channel, config);
        }, 1000); // Wait 1 second after join to ensure channel is ready
      }
    })
    .receive('error', (resp) => {
      const roomType = config.agentRoom ? 'agent room' : 'conversation';
      console.error(`❌ [${formatTime()}] Failed to join ${roomType}:`, resp);
      process.exit(1);
    })
    .receive('timeout', () => {
      console.error(`⏱️  [${formatTime()}] Join timeout`);
      process.exit(1);
    });

  // Track conversation updates for agent room
  const conversationUpdates = config.agentRoom ? new Map() : null;
  let totalUpdates = 0;

  if (config.agentRoom) {
    // Listen for conversation updates (agent room)
    channel.on('conversation_update', (payload) => {
      totalUpdates++;
      const conversationId = payload.conversation_id || `${payload.client_id}:${payload.user_identifier}`;
      
      // Track updates per conversation
      if (!conversationUpdates.has(conversationId)) {
        conversationUpdates.set(conversationId, 0);
      }
      conversationUpdates.set(conversationId, conversationUpdates.get(conversationId) + 1);

      console.log('');
      console.log('📢 ========================================');
      console.log(`📢 [${formatTime()}] Conversation Update #${totalUpdates}`);
      console.log('📢 ========================================');
      console.log(`   Event ID: ${payload.event_id}`);
      console.log(`   Event Type: ${formatEventType(payload.event_type)}`);
      console.log(`   Conversation ID: ${payload.conversation_id || 'N/A'}`);
      console.log(`   Client ID: ${payload.client_id || 'N/A'}`);
      console.log(`   User Identifier: ${payload.user_identifier || 'N/A'}`);
      console.log(`   Hashed ID: ${payload.hashed_id || payload.hashedId || 'N/A'}`);
      console.log(`   Timestamp: ${payload.timestamp}`);
      
      // Display content if available
      if (payload.content) {
        try {
          const content = typeof payload.content === 'string' ? JSON.parse(payload.content) : payload.content;
          if (Array.isArray(content) && content.length > 0) {
            const firstMessage = content[0];
            const messageText = firstMessage.text || firstMessage.content || JSON.stringify(firstMessage);
            console.log(`   Content: ${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}`);
          } else if (typeof content === 'string' && content.length > 0) {
            console.log(`   Content: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
          }
        } catch (e) {
          // Content might not be JSON, display as-is
          const contentStr = String(payload.content);
          if (contentStr.length > 0) {
            console.log(`   Content: ${contentStr.substring(0, 100)}${contentStr.length > 100 ? '...' : ''}`);
          }
        }
      }
      
      // Display sender info if available
      if (payload.sender) {
        const sender = payload.sender;
        console.log(`   Sender: ${sender.displayName || sender.name || sender.id || 'N/A'} (${sender.type || 'unknown'})`);
      }
      
      console.log('');
      console.log('   📊 Stats:');
      console.log(`     Total Updates: ${totalUpdates}`);
      console.log(`     Updates for this conversation: ${conversationUpdates.get(conversationId)}`);
      console.log(`     Unique conversations: ${conversationUpdates.size}`);
      console.log('');
      console.log('   💡 This update should trigger a refresh of the conversation list');
      console.log('      in your UI. You can use conversation_id or hashed_id to identify');
      console.log('      which conversation to update or refresh the entire list.');
      console.log('📢 ========================================');
      console.log('');
    });
  } else {
    // Listen for new messages (conversation room)
    channel.on('new_message', (payload) => {
      console.log('');
      console.log('📨 ========================================');
      console.log(`📨 [${formatTime()}] New Message Received`);
      console.log('📨 ========================================');
      console.log(`   Event ID: ${payload.event_id}`);
      console.log(`   Event Type: ${formatEventType(payload.event_type)}`);
      console.log(`   Conversation ID: ${payload.conversation_id}`);
      console.log(`   Timestamp: ${payload.timestamp}`);
      console.log('');
      console.log('   Sender:');
      console.log(`     Type: ${payload.sender?.type || 'unknown'}`);
      console.log(`     ID: ${payload.sender?.id || 'unknown'}`);
      console.log(`     Display Name: ${payload.sender?.displayName || 'N/A'}`);
      console.log(`     Role: ${payload.sender?.roleLabel || 'N/A'}`);
      if (payload.sender?.avatarUrl) {
        console.log(`     Avatar: ${payload.sender.avatarUrl}`);
      }
      console.log('');
      console.log('   Content:');
      const content = formatContent(payload.content);
      const lines = content.split('\n');
      lines.forEach(line => {
        console.log(`     ${line}`);
      });
      console.log('📨 ========================================');
      console.log('');
    });
  }

  // Listen for typing indicators (only for conversation room)
  if (!config.agentRoom) {
    channel.on('typing', (payload) => {
      console.log(`⌨️  [${formatTime()}] ${payload.user_name || payload.user_id} is typing...`);
    });

    channel.on('stop_typing', (payload) => {
      console.log(`⌨️  [${formatTime()}] ${payload.user_name || payload.user_id} stopped typing`);
    });
  }

  // Function to send message
  function sendMessage(channel, config) {
    console.log('');
    console.log('📤 ========================================');
    console.log(`📤 [${formatTime()}] Sending Message`);
    console.log('📤 ========================================');
    console.log(`   Conversation ID: ${config.conversationId}`);
    console.log(`   Content: ${config.content}`);
    console.log(`   Message Type: ${config.messageType}`);
    console.log('');

    const payload = {
      conversationId: config.conversationId,
      content: config.content,
      messageType: config.messageType
    };

    channel.push('send_message', payload)
      .receive('ok', (resp) => {
        console.log(`✅ [${formatTime()}] Message sent successfully!`);
        console.log(`   Entry ID: ${resp.entryId || resp.entry_id || 'N/A'}`);
        console.log(`   Status: ${resp.status || 'ok'}`);
        console.log(`   Message: ${resp.message || 'Message published successfully'}`);
        console.log('📤 ========================================');
        console.log('');
        console.log('💡 The message has been published to the Redis stream.');
        console.log('   It will be consumed by the outgoing message handler and sent via WhatsApp.');
        console.log('');
      })
      .receive('error', (resp) => {
        console.error(`❌ [${formatTime()}] Failed to send message:`);
        console.error(`   Status: ${resp.status || 'error'}`);
        console.error(`   Reason: ${resp.reason || 'unknown_error'}`);
        console.error(`   Full response:`, JSON.stringify(resp, null, 2));
        console.log('📤 ========================================');
        console.log('');
      })
      .receive('timeout', () => {
        console.error(`⏱️  [${formatTime()}] Send message timeout`);
        console.log('📤 ========================================');
        console.log('');
      });
  }

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('');
    console.log('👋 Disconnecting...');
    if (config.agentRoom && conversationUpdates) {
      console.log('');
      console.log('📊 Final Statistics:');
      console.log(`   Total Updates Received: ${totalUpdates}`);
      console.log(`   Unique Conversations: ${conversationUpdates.size}`);
      if (conversationUpdates.size > 0) {
        console.log('');
        console.log('   Updates per conversation:');
        const sorted = Array.from(conversationUpdates.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10); // Top 10
        sorted.forEach(([convId, count]) => {
          console.log(`     ${convId}: ${count} update(s)`);
        });
        if (conversationUpdates.size > 10) {
          console.log(`     ... and ${conversationUpdates.size - 10} more`);
        }
      }
    }
    console.log('');
    channel.leave();
    socket.disconnect();
    setTimeout(() => {
      console.log('✅ Disconnected');
      process.exit(0);
    }, 1000);
  });

  // Keep process alive
  process.on('SIGTERM', () => {
    console.log('');
    console.log('👋 Disconnecting...');
    channel.leave();
    socket.disconnect();
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });
}

// Run the script
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
