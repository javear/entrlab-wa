#!/usr/bin/env node

/**
 * Migrate Weaviate Schema - Add content field to ChatEvent
 * 
 * This script adds the 'content' field to the existing ChatEvent schema
 * while keeping the 'payload' field for backward compatibility
 * 
 * Usage:
 *   node scripts/migrate-weaviate-schema.js
 */

require('dotenv').config();

// Try to load weaviate-ts-client from multiple possible locations
let weaviateModule;
try {
  weaviateModule = require('weaviate-ts-client');
} catch (e) {
  try {
    weaviateModule = require('../services/pubsub/node_modules/weaviate-ts-client');
  } catch (e2) {
    console.error('❌ Error: weaviate-ts-client not found');
    console.error('   Please run: cd services/pubsub && npm install');
    process.exit(1);
  }
}

const weaviate = weaviateModule.default || weaviateModule;

// Initialize Weaviate client
function initializeClient() {
  const weaviateUrl = process.env.WEAVIATE_URL || 'http://localhost:8080';
  
  let scheme = 'http';
  let host = '';
  let port = 8080;

  if (weaviateUrl.startsWith('http://') || weaviateUrl.startsWith('https://')) {
    const url = new URL(weaviateUrl);
    scheme = url.protocol === 'https:' ? 'https' : 'http';
    host = url.hostname;
    port = url.port ? parseInt(url.port) : (scheme === 'https' ? 443 : 8080);
  } else {
    const parts = weaviateUrl.split(':');
    host = parts[0];
    if (parts.length > 1) {
      port = parseInt(parts[1]) || 8080;
    } else {
      if (weaviateUrl.includes('railway') || weaviateUrl.includes('.up.') || weaviateUrl.includes('.app')) {
        scheme = 'https';
        port = 443;
      }
    }
  }

  const clientConfig = {
    scheme,
    host,
  };

  if ((scheme === 'http' && port !== 8080) || (scheme === 'https' && port !== 443)) {
    clientConfig.port = port;
  }

  if (process.env.WEAVIATE_API_KEY) {
    clientConfig.headers = {
      'Authorization': `Bearer ${process.env.WEAVIATE_API_KEY}`
    };
  }

  if (process.env.OPENAI_API_KEY) {
    if (!clientConfig.headers) clientConfig.headers = {};
    clientConfig.headers['X-OpenAI-Api-Key'] = process.env.OPENAI_API_KEY;
  }

  return weaviate.client(clientConfig);
}

// Main function
async function main() {
  try {
    console.log('🔍 Connecting to Weaviate...');
    const client = initializeClient();

    // Test connection
    await client.misc.metaGetter().do();
    console.log('✅ Connected to Weaviate\n');

    // Get current ChatEvent schema
    console.log('📋 Checking ChatEvent schema...');
    const chatEventSchema = await client.schema.classGetter().withClassName('ChatEvent').do();
    
    const chatEventProperties = (chatEventSchema.properties || []).map(p => p.name);
    console.log(`   ChatEvent properties: ${chatEventProperties.join(', ')}\n`);

    // Add content field to ChatEvent if it doesn't exist
    if (!chatEventProperties.includes('content')) {
      console.log('➕ Adding content field to ChatEvent schema...');
      await client.schema
        .propertyCreator()
        .withClassName('ChatEvent')
        .withProperty({
          name: 'content',
          dataType: ['text'],
          description: 'Formatted message content as JSON array (e.g., [{"type":"text","text":"Hello"}])',
          indexInverted: false
        })
        .do();
      console.log('✅ Successfully added content field to ChatEvent schema\n');
    } else {
      console.log('✅ Content field already exists in ChatEvent schema\n');
    }

    // Get current Conversation schema
    console.log('📋 Checking Conversation schema...');
    const conversationSchema = await client.schema.classGetter().withClassName('Conversation').do();
    
    const conversationProperties = (conversationSchema.properties || []).map(p => p.name);
    console.log(`   Conversation properties: ${conversationProperties.join(', ')}\n`);

    // Add hashed_id field to Conversation if it doesn't exist
    if (!conversationProperties.includes('hashed_id')) {
      console.log('➕ Adding hashed_id field to Conversation schema...');
      await client.schema
        .propertyCreator()
        .withClassName('Conversation')
        .withProperty({
          name: 'hashed_id',
          dataType: ['string'],
          description: 'Hashed room ID for universal identification across services (agentCode:clientId:userIdentifier)',
          indexFilterable: true
        })
        .do();
      console.log('✅ Successfully added hashed_id field to Conversation schema\n');
    } else {
      console.log('✅ hashed_id field already exists in Conversation schema\n');
    }

    // Add client_id field to Conversation if it doesn't exist
    if (!conversationProperties.includes('client_id')) {
      console.log('➕ Adding client_id field to Conversation schema...');
      await client.schema
        .propertyCreator()
        .withClassName('Conversation')
        .withProperty({
          name: 'client_id',
          dataType: ['string'],
          description: 'Client identifier (e.g., "javear-client-wpp")',
          indexInverted: true
        })
        .do();
      console.log('✅ Successfully added client_id field to Conversation schema\n');
    } else {
      console.log('✅ client_id field already exists in Conversation schema\n');
    }

    // Add platform field to Conversation if it doesn't exist
    if (!conversationProperties.includes('platform')) {
      console.log('➕ Adding platform field to Conversation schema...');
      await client.schema
        .propertyCreator()
        .withClassName('Conversation')
        .withProperty({
          name: 'platform',
          dataType: ['string'],
          description: 'Platform type: "wpp" (WPPConnect) or "wa-official" (WhatsApp Official)',
          indexInverted: true
        })
        .do();
      console.log('✅ Successfully added platform field to Conversation schema\n');
    } else {
      console.log('✅ platform field already exists in Conversation schema\n');
    }

    // Add last event fields to Conversation if they don't exist
    const lastEventFields = [
      { name: 'last_event_id', dataType: ['string'], description: 'ID of the last event in the conversation', indexInverted: false },
      { name: 'last_event_type', dataType: ['string'], description: 'Type of the last event (message:incoming, ai:response)', indexInverted: true },
      { 
        name: 'last_event_content', 
        dataType: ['text'], 
        description: 'Content of the last event (formatted message array as JSON string, e.g., [{"type":"text","text":"Hello"}])',
        indexInverted: false 
      },
      { name: 'last_sender_type', dataType: ['string'], description: 'Type of the last sender (user, ai:agent)', indexInverted: true },
      { name: 'last_sender_id', dataType: ['string'], description: 'ID of the last sender', indexInverted: false },
      { name: 'last_sender_display_name', dataType: ['string'], description: 'Display name of the last sender', indexInverted: false }
    ];

    for (const field of lastEventFields) {
      if (!conversationProperties.includes(field.name)) {
        console.log(`➕ Adding ${field.name} field to Conversation schema...`);
        await client.schema
          .propertyCreator()
          .withClassName('Conversation')
          .withProperty(field)
          .do();
        console.log(`✅ Successfully added ${field.name} field to Conversation schema\n`);
      } else {
        console.log(`✅ ${field.name} field already exists in Conversation schema\n`);
      }
    }

    // Add last_attention field to Conversation if it doesn't exist
    if (!conversationProperties.includes('last_attention')) {
      console.log('➕ Adding last_attention field to Conversation schema...');
      await client.schema
        .propertyCreator()
        .withClassName('Conversation')
        .withProperty({
          name: 'last_attention',
          dataType: ['text'],
          description: 'Current needAttention status (JSON string: {option, reason, from, to, taken})',
          indexFilterable: false
        })
        .do();
      console.log('✅ Successfully added last_attention field to Conversation schema\n');
    } else {
      console.log('✅ last_attention field already exists in Conversation schema\n');
    }

    // Check participant_ids property configuration
    console.log('\n📋 Checking participant_ids property configuration...');
    const participantIdsProperty = conversationSchema.properties?.find((p) => p.name === 'participant_ids');
    if (participantIdsProperty) {
      console.log(`   Current participant_ids config:`, {
        indexInverted: participantIdsProperty.indexInverted,
        indexFilterable: participantIdsProperty.indexFilterable
      });
      
      if (!participantIdsProperty.indexFilterable && !participantIdsProperty.indexInverted) {
        console.log('\n⚠️  WARNING: participant_ids is not filterable!');
        console.log('   This will cause errors when querying by participant_ids.');
        console.log('   To fix this, you need to:');
        console.log('   1. Delete the participant_ids property (THIS WILL DELETE DATA)');
        console.log('   2. Recreate it with indexFilterable: true');
        console.log('   3. Re-import all conversation data');
        console.log('\n   For now, the service will use in-memory filtering as a workaround.');
      } else {
        console.log('✅ participant_ids is filterable');
      }
    }

    console.log('\n✨ Migration complete!');
    console.log('   Note: The payload field in ChatEvent is kept for backward compatibility.');
    console.log('   New events will use the content field.');
    console.log('   New conversations will include client_id, platform, and last event fields.');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response, null, 2));
    }
    process.exit(1);
  }
}

main();

