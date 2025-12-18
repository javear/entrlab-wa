#!/usr/bin/env node

/**
 * Test WhatsApp Official Message Flow
 * 
 * This script tests the complete message flow:
 * 1. Send read receipt (if messageId provided)
 * 2. Generate AI response
 * 3. Send formatted response bubbles
 * 
 * Note: Typing indicators are NOT supported by Meta's WhatsApp Business API
 * 
 * Usage:
 *   node scripts/test-wa-official-message.js --clientId my-client --message "Hello" --phoneNumber "1234567890" [options]
 * 
 * Options:
 *   --clientId       Client ID (required)
 *   --message        Message to reply to (required)
 *   --phoneNumber    Phone number to reply to (required)
 *   --messageId      Message ID for read receipt (optional)
 *   --port           Server port for MongoDB connection (default: uses MONGODB_URI)
 */

require('dotenv').config();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const path = require('path');

// Import client manager and message controller
const clientManagerPath = path.join(__dirname, '../services/whatsapp-official/services/client-manager.js');
const messageControllerPath = path.join(__dirname, '../services/whatsapp-official/controllers/message.controller.js');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    clientId: null,
    message: null,
    phoneNumber: null,
    messageId: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--clientId':
      case '-c':
        config.clientId = nextArg;
        i++;
        break;
      case '--message':
      case '-m':
        config.message = nextArg;
        i++;
        break;
      case '--phoneNumber':
      case '-p':
      case '--phone':
        config.phoneNumber = nextArg;
        i++;
        break;
      case '--messageId':
      case '--msgId':
      case '-i':
        config.messageId = nextArg;
        i++;
        break;
      case '--help':
      case '-h':
        console.log(`
Test WhatsApp Official Message Flow

Usage:
  node scripts/test-wa-official-message.js --clientId <clientId> --message <message> --phoneNumber <phoneNumber> [options]

Required:
  --clientId, -c       Client ID
  --message, -m        Message to reply to
  --phoneNumber, -p    Phone number to reply to (with country code, no +)

Optional:
  --messageId, -i      Message ID for read receipt (optional)
  --help, -h           Show this help message

Example:
  node scripts/test-wa-official-message.js -c my-client -m "Hello, how are you?" -p 6281234567890
  node scripts/test-wa-official-message.js -c my-client -m "Hello" -p 6281234567890 -i wamid.xxx
        `);
        process.exit(0);
        break;
    }
  }

  return config;
}

// Send read receipt
async function sendReadReceipt(clientId, messageId, clientManager) {
  try {
    const accessToken = await clientManager.getAccessToken(clientId);
    const phoneNumberId = await clientManager.getPhoneNumberId(clientId);
    
    if (!accessToken || !phoneNumberId) {
      console.warn(`⚠️  Cannot send read receipt - missing credentials for client ${clientId}`);
      return false;
    }

    const apiVersion = process.env.WA_API_VERSION || 'v21.0';
    const baseUrl = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}`;
    const requestUrl = `${baseUrl}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    };

    console.log(`📖 Sending read receipt for message ${messageId}...`);
    const response = await axios.post(requestUrl, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`✅ Read receipt sent successfully`);
    return true;
  } catch (error) {
    console.error(`❌ Error sending read receipt:`, error.response?.data || error.message);
    return false;
  }
}

// Note: Typing indicators are NOT supported by Meta's WhatsApp Business API (REST API)
// Typing indicators are only available in WhatsApp Web API (used by WPPConnect)
// This feature has been removed from the test script

// Get agent code from PlatformClientAgent
async function getClientAgent(clientId, clientManager) {
  try {
    await clientManager.initialize();
    const ClientAgent = clientManager.getClientAgentModel();
    
    const client = await ClientAgent.findOne({
      clientId,
      platform: 'wa-official',
      isActive: true
    }).select('ai_agent_code');

    if (!client || !client.ai_agent_code) {
      throw new Error(`No agent code found for client ${clientId}`);
    }

    return client.ai_agent_code;
  } catch (error) {
    console.error(`❌ Error getting agent code:`, error.message);
    throw error;
  }
}

// Call AI workflow endpoint
async function callInferenceFw(message, phoneNumber, clientId, agentCode) {
  try {
    const url = process.env.FW_ENDPOINT_WORKFLOW;
    if (!url) {
      throw new Error('FW_ENDPOINT_WORKFLOW environment variable is required');
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET environment variable is not set');
    }

    // Generate JWT token
    const payload = {
      iss: 'whatsapp-bot',
      sub: `wa_${phoneNumber}`,
      aud: 'authenticated',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      identifier: phoneNumber,
      role: 'authenticated',
      agent_metadata: {
        agent_code: agentCode,
        status: 'active'
      },
      client_metadata: {
        client_id: clientId,
        client_name: 'WhatsApp Official Bot',
        app_metadata: {
          provider: 'wa-official'
        }
      },
      user_metadata: {
        phone: phoneNumber,
        phone_verified: true,
        full_name: phoneNumber,
        participant_name: phoneNumber,
        participant_phone: phoneNumber,
        message_timestamp: Math.floor(Date.now() / 1000),
        client_id: clientId
      }
    };

    const authToken = jwt.sign(payload, jwtSecret, { algorithm: 'HS256' });

      // Workflow format request body
      // Note: agent_code is hardcoded as "generalAssistanceAgent" (same as WPPConnect)
      // The actual agent code is passed in JWT agent_metadata for the workflow to use
      const requestBody = {
        inputData: {
          agent_code: "generalAssistanceAgent", // HARDCODED (same as WPPConnect)
          format: "whatsapp", // HARDCODED
          messages: [
            {
              role: "user", // HARDCODED
              content: message // the [message]
            }
          ],
          client_platform: "whatsapp",
          memory: {
            resourceId: `${agentCode}:${phoneNumber}`, // Use actual agentCode for memory
            threadId: `${agentCode}:${phoneNumber}:whatsapp` // Use actual agentCode for memory
          }
        }
      };

    const timeoutMs = parseInt(process.env.AI_REQUEST_TIMEOUT || '300000', 10);
    
    console.log(`🤖 Calling AI workflow endpoint...`);
    console.log(`   Agent: ${agentCode}`);
    console.log(`   Message: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);

    const response = await axios.post(url, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      timeout: timeoutMs
    });

    console.log(`✅ AI workflow responded successfully`);
    return response.data;
  } catch (error) {
    console.error(`❌ Error calling AI workflow:`, error.response?.data || error.message);
    throw error;
  }
}

// Send workflow messages
async function sendWorkflowMessages(clientId, phoneNumber, messageObjects, messageController) {
  console.log(`📤 Sending ${messageObjects.length} message bubble(s)...`);
  
  for (let i = 0; i < messageObjects.length; i++) {
    const msgObj = messageObjects[i];
    if (!msgObj || !msgObj.type) continue;

    try {
      switch (msgObj.type) {
        case 'text':
          if (msgObj.text) {
            await messageController.sendTextMessage(clientId, phoneNumber, msgObj.text);
            console.log(`✅ [${i + 1}/${messageObjects.length}] Sent text: ${msgObj.text.substring(0, 50)}...`);
          }
          break;

        case 'image':
          if (msgObj.url) {
            await messageController.sendMediaMessage(clientId, phoneNumber, 'image', msgObj.url, msgObj.caption || '');
            console.log(`✅ [${i + 1}/${messageObjects.length}] Sent image: ${msgObj.url}`);
          }
          break;

        case 'video':
          if (msgObj.url) {
            await messageController.sendMediaMessage(clientId, phoneNumber, 'video', msgObj.url, msgObj.caption || '');
            console.log(`✅ [${i + 1}/${messageObjects.length}] Sent video: ${msgObj.url}`);
          }
          break;

        case 'audio':
          if (msgObj.url) {
            await messageController.sendMediaMessage(clientId, phoneNumber, 'audio', msgObj.url);
            console.log(`✅ [${i + 1}/${messageObjects.length}] Sent audio: ${msgObj.url}`);
          }
          break;

        case 'file':
        case 'document':
          if (msgObj.url) {
            await messageController.sendMediaMessage(clientId, phoneNumber, 'document', msgObj.url, msgObj.caption || '');
            console.log(`✅ [${i + 1}/${messageObjects.length}] Sent document: ${msgObj.url}`);
          }
          break;

        case 'location':
          if (msgObj.latitude !== undefined && msgObj.longitude !== undefined) {
            const locationText = `📍 Location: ${msgObj.latitude}, ${msgObj.longitude}${msgObj.caption ? ` - ${msgObj.caption}` : ''}`;
            await messageController.sendTextMessage(clientId, phoneNumber, locationText);
            console.log(`✅ [${i + 1}/${messageObjects.length}] Sent location: ${msgObj.latitude}, ${msgObj.longitude}`);
          }
          break;

        default:
          console.warn(`⚠️  Unknown message type: ${msgObj.type}`);
      }
    } catch (error) {
      console.error(`⚠️  Error sending ${msgObj.type}:`, error.message);
    }

    // Delay between messages (1-3 seconds)
    if (i < messageObjects.length - 1 && msgObj.type !== 'reaction') {
      const delayMs = 1000 + Math.floor(Math.random() * 2000);
      console.log(`⏳ Waiting ${delayMs}ms before next message...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  console.log(`✅ All message bubbles sent successfully!`);
}

// Main function
async function main() {
  const config = parseArgs();

  // Validate required parameters
  if (!config.clientId) {
    console.error('❌ Error: --clientId is required');
    console.log('Use --help for usage information');
    process.exit(1);
  }

  if (!config.message) {
    console.error('❌ Error: --message is required');
    console.log('Use --help for usage information');
    process.exit(1);
  }

  if (!config.phoneNumber) {
    console.error('❌ Error: --phoneNumber is required');
    console.log('Use --help for usage information');
    process.exit(1);
  }

  console.log('\n🧪 WhatsApp Official Message Flow Test');
  console.log('=====================================\n');
  console.log(`Client ID: ${config.clientId}`);
  console.log(`Phone Number: ${config.phoneNumber}`);
  console.log(`Message: ${config.message}`);
  if (config.messageId) {
    console.log(`Message ID: ${config.messageId}`);
  }
  console.log('');

  try {
    // Initialize MongoDB connection (client manager will handle this)
    const clientManager = require(clientManagerPath);
    await clientManager.initialize();

    // Step 1: Send read receipt (if messageId provided)
    if (config.messageId) {
      console.log('📖 Step 1: Sending read receipt...');
      await sendReadReceipt(config.clientId, config.messageId, clientManager);
      console.log('');
    } else {
      console.log('ℹ️  Step 1: Skipping read receipt (no messageId provided)');
      console.log('');
    }

    // Step 2: Get agent code
    // Note: Typing indicators are not supported by Meta's WhatsApp Business API
    console.log('🤖 Step 2: Getting agent code...');
    const agentCode = await getClientAgent(config.clientId, clientManager);
    console.log(`✅ Agent code: ${agentCode}`);
    console.log('');

    // Step 3: Call AI workflow
    console.log('🧠 Step 3: Calling AI workflow...');
    const workflowResponse = await callInferenceFw(config.message, config.phoneNumber, config.clientId, agentCode);
    console.log('');

    // Step 4: Check for errors first
    if (workflowResponse?.result?.success === false || workflowResponse?.result?.error) {
      const errorMessage = workflowResponse.result.error || 'Unknown error occurred';
      console.error(`❌ Workflow error: ${errorMessage}`);
      console.error('Full response:', JSON.stringify(workflowResponse, null, 2));
      process.exit(1);
    }

    // Step 5: Validate response structure
    if (!workflowResponse || !workflowResponse.result || !workflowResponse.result.content) {
      console.error('❌ Invalid workflow response structure');
      console.error('Response keys:', workflowResponse ? Object.keys(workflowResponse) : 'null');
      console.error('Full response:', JSON.stringify(workflowResponse, null, 2));
      process.exit(1);
    }

    // Step 6: Send formatted response bubbles
    console.log('📤 Step 4: Sending formatted response bubbles...');
    
    // Use formatted.whatsapp as primary source, fallback to content.object
    let messageObjects = [];
    
    if (workflowResponse?.result?.formatted?.whatsapp && Array.isArray(workflowResponse.result.formatted.whatsapp) && workflowResponse.result.formatted.whatsapp.length > 0) {
      messageObjects = workflowResponse.result.formatted.whatsapp;
      console.log(`   Using formatted.whatsapp: ${messageObjects.length} message(s)`);
    } else if (workflowResponse?.result?.content?.object && Array.isArray(workflowResponse.result.content.object) && workflowResponse.result.content.object.length > 0) {
      messageObjects = workflowResponse.result.content.object;
      console.log(`   Using content.object: ${messageObjects.length} message(s)`);
    } else if (workflowResponse?.result?.content?.text) {
      // Fallback to text only
      const WhatsAppMessageController = require(messageControllerPath);
      const messageController = new WhatsAppMessageController();
      await messageController.sendTextMessage(config.clientId, config.phoneNumber, workflowResponse.result.content.text);
      console.log(`✅ Sent text-only response`);
      console.log('\n✅ Test completed successfully!');
      process.exit(0);
    } else {
      console.error('❌ No valid response format found in AI workflow response');
      console.error('Response structure:', JSON.stringify(workflowResponse, null, 2));
      process.exit(1);
    }

    if (messageObjects.length > 0) {
      const WhatsAppMessageController = require(messageControllerPath);
      const messageController = new WhatsAppMessageController();
      await sendWorkflowMessages(config.clientId, config.phoneNumber, messageObjects, messageController);
    } else {
      console.error('❌ No message objects to send');
      process.exit(1);
    }

    console.log('\n✅ Test completed successfully!');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    // Close MongoDB connection
    try {
      await mongoose.connection.close();
    } catch (error) {
      // Ignore connection close errors
    }
  }
}

// Run the script
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { main };

