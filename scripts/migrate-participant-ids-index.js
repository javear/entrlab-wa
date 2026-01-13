#!/usr/bin/env node

/**
 * Migrate Weaviate Schema - Fix participant_ids Index
 * 
 * This script deletes and recreates the Conversation schema to enable
 * filtering on participant_ids by setting indexFilterable: true
 * 
 * WARNING: This will delete all Conversation data!
 * 
 * Usage:
 *   node scripts/migrate-participant-ids-index.js
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
    host = parts[0] || '';
    if (parts.length > 1 && parts[1]) {
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

    // Check if Conversation schema exists
    console.log('📋 Checking Conversation schema...');
    let conversationSchema;
    try {
      conversationSchema = await client.schema.classGetter().withClassName('Conversation').do();
      console.log('✅ Conversation schema exists');
      
      // Check participant_ids property
      const participantIdsProperty = conversationSchema.properties?.find((p) => p.name === 'participant_ids');
      if (participantIdsProperty) {
        const isFilterable = participantIdsProperty.indexFilterable === true;
        console.log(`   participant_ids indexFilterable: ${participantIdsProperty.indexFilterable}`);
        console.log(`   participant_ids indexInverted: ${participantIdsProperty.indexInverted} (deprecated)`);
        
        if (isFilterable) {
          console.log('\n✅ participant_ids is already filterable. No migration needed.');
          return;
        }
      }
    } catch (error) {
      console.log('ℹ️  Conversation schema does not exist yet');
      console.log('   It will be created with correct settings on next service start.');
      return;
    }

    // Confirm deletion
    console.log('\n⚠️  WARNING: This will DELETE all Conversation data!');
    console.log('   This includes all conversations across all tenants.');
    console.log('   ChatEvent data will NOT be affected.');
    console.log('\n   To proceed, type "DELETE" and press Enter:');
    
    // For non-interactive mode, check for --force flag
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    
    if (!force) {
      // In a real scenario, you'd want to use readline for interactive input
      // For now, we'll require --force flag for safety
      console.log('\n❌ Migration cancelled. Use --force flag to proceed without confirmation.');
      console.log('   Example: node scripts/migrate-participant-ids-index.js --force');
      process.exit(1);
    }

    console.log('\n🗑️  Deleting Conversation schema...');
    await client.schema.classDeleter().withClassName('Conversation').do();
    console.log('✅ Conversation schema deleted\n');

    // Recreate schema with correct configuration
    console.log('📝 Recreating Conversation schema with indexFilterable: true for participant_ids...');
    
    const CONVERSATION_SCHEMA = {
      class: 'Conversation',
      description: 'Represents a conversation between participants',
      multiTenancyConfig: {
        enabled: true
      },
      vectorizer: 'none',
      properties: [
        {
          name: 'conversation_id',
          dataType: ['string'],
          description: 'Unique identifier for the conversation',
          indexFilterable: true
        },
        {
          name: 'client_id',
          dataType: ['string'],
          description: 'Client identifier (e.g., "javear-client-wpp")',
          indexFilterable: true
        },
        {
          name: 'platform',
          dataType: ['string'],
          description: 'Platform type: "wpp" (WPPConnect) or "wa-official" (WhatsApp Official)',
          indexFilterable: true
        },
        {
          name: 'title',
          dataType: ['string'],
          description: 'Optional title for the conversation'
        },
        {
          name: 'participant_ids',
          dataType: ['string[]'],
          description: 'Array of participant identifiers',
          indexFilterable: true
        },
        {
          name: 'created_at',
          dataType: ['date'],
          description: 'When the conversation was created'
        },
        {
          name: 'last_event_at',
          dataType: ['date'],
          description: 'Timestamp of the last event in the conversation'
        },
        {
          name: 'last_event_id',
          dataType: ['string'],
          description: 'ID of the last event in the conversation'
        },
        {
          name: 'last_event_type',
          dataType: ['string'],
          description: 'Type of the last event (message:incoming, ai:response)',
          indexFilterable: true
        },
        {
          name: 'last_event_content',
          dataType: ['text'],
          description: 'Content of the last event (formatted message array as JSON string, e.g., [{"type":"text","text":"Hello"}])'
        },
        {
          name: 'last_sender_type',
          dataType: ['string'],
          description: 'Type of the last sender (user, ai:agent)',
          indexFilterable: true
        },
        {
          name: 'last_sender_id',
          dataType: ['string'],
          description: 'ID of the last sender'
        },
        {
          name: 'last_sender_display_name',
          dataType: ['string'],
          description: 'Display name of the last sender'
        },
        {
          name: 'status',
          dataType: ['string'],
          description: 'Conversation status: open or closed',
          indexFilterable: true
        },
        {
          name: 'metadata',
          dataType: ['text'],
          description: 'Additional metadata about the conversation (stored as JSON string for flexibility)'
        }
      ]
    };

    await client.schema.classCreator().withClass(CONVERSATION_SCHEMA).do();
    console.log('✅ Conversation schema recreated with correct indexing\n');

    // Verify the property is now filterable
    const newSchema = await client.schema.classGetter().withClassName('Conversation').do();
    const participantIdsProp = newSchema.properties?.find((p) => p.name === 'participant_ids');
    if (participantIdsProp) {
      console.log('✅ Verification:');
      console.log(`   participant_ids indexFilterable: ${participantIdsProp.indexFilterable}`);
      console.log(`   participant_ids indexInverted: ${participantIdsProp.indexInverted}`);
    }

    console.log('\n✨ Migration complete!');
    console.log('   The Conversation schema has been recreated with indexFilterable: true for participant_ids.');
    console.log('   New conversations will be created automatically by the weaviate-consumer service.');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response, null, 2));
    }
    process.exit(1);
  }
}

main();
