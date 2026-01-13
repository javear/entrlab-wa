#!/usr/bin/env node

/**
 * Delete Conversations and ChatEvents from Weaviate
 * 
 * Delete conversations and their associated chat events from Weaviate
 * 
 * Usage:
 *   node scripts/delete-weaviate.js --tenant <agent_code> --conversation <conversation_id> [options]
 * 
 * Options:
 *   --tenant <agent_code>        Tenant (agent_code) [required]
 *   --conversation <id>          Conversation ID to delete [required]
 *   --include-events             Also delete all ChatEvents associated with this conversation (default: true)
 *   --dry-run                    Show what would be deleted without actually deleting
 *   --force                      Skip confirmation prompt
 */

require('dotenv').config();

// Try to load weaviate-ts-client from multiple possible locations
let weaviateModule;
try {
  // Try root node_modules first
  weaviateModule = require('weaviate-ts-client');
} catch (e) {
  try {
    // Try pubsub service node_modules
    weaviateModule = require('../services/pubsub/node_modules/weaviate-ts-client');
  } catch (e2) {
    console.error('❌ Error: weaviate-ts-client not found');
    console.error('   Please run: cd services/pubsub && npm install');
    process.exit(1);
  }
}

const weaviate = weaviateModule.default || weaviateModule;
const readline = require('readline');

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name, defaultValue = null) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : defaultValue;
};
const hasFlag = (name) => args.includes(name);

const tenant = getArg('--tenant');
const conversationId = getArg('--conversation');
const includeEvents = hasFlag('--include-events') || !hasFlag('--no-events'); // Default to true
const dryRun = hasFlag('--dry-run');
const force = hasFlag('--force');

if (!tenant || !conversationId) {
  console.error('❌ Error: --tenant and --conversation are required');
  console.log('\nUsage:');
  console.log('  node scripts/delete-weaviate.js --tenant <agent_code> --conversation <conversation_id> [options]');
  console.log('\nOptions:');
  console.log('  --tenant <agent_code>        Tenant (agent_code) [required]');
  console.log('  --conversation <id>          Conversation ID to delete [required]');
  console.log('  --include-events             Also delete all ChatEvents (default: true)');
  console.log('  --no-events                  Only delete Conversation, keep ChatEvents');
  console.log('  --dry-run                    Show what would be deleted without actually deleting');
  console.log('  --force                      Skip confirmation prompt');
  process.exit(1);
}

// Initialize Weaviate client
function initializeClient() {
  const weaviateUrl = process.env.WEAVIATE_URL || 'http://localhost:8080';
  
  // Parse URL
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

// Prompt for confirmation
function promptConfirmation(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

// Get conversation with UUID
async function getConversation(client, tenant, conversationId) {
  const result = await client.graphql
    .get()
    .withClassName('Conversation')
    .withTenant(tenant)
    .withFields('conversation_id participant_ids created_at last_event_at status metadata _additional { id }')
    .withWhere({
      path: ['conversation_id'],
      operator: 'Equal',
      valueString: conversationId
    })
    .withLimit(1)
    .do();

  const conversations = result.data?.Get?.Conversation || [];
  return conversations.length > 0 ? conversations[0] : null;
}

// Get chat events for a conversation
async function getChatEvents(client, tenant, conversationId) {
  const result = await client.graphql
    .get()
    .withClassName('ChatEvent')
    .withTenant(tenant)
    .withFields('event_id event_type created_at _additional { id }')
    .withWhere({
      path: ['conversation_id'],
      operator: 'Equal',
      valueString: conversationId
    })
    .do();

  return result.data?.Get?.ChatEvent || [];
}

// Delete conversation by UUID
async function deleteConversation(client, tenant, conversationUuid) {
  await client.data
    .deleter()
    .withId(conversationUuid)
    .withClassName('Conversation')
    .withTenant(tenant)
    .do();
}

// Delete chat event by UUID
async function deleteChatEvent(client, tenant, eventUuid) {
  await client.data
    .deleter()
    .withId(eventUuid)
    .withClassName('ChatEvent')
    .withTenant(tenant)
    .do();
}

// Main function
async function main() {
  try {
    console.log('🔍 Connecting to Weaviate...');
    const client = initializeClient();

    // Test connection
    await client.misc.metaGetter().do();
    console.log('✅ Connected to Weaviate\n');

    // Get conversation
    console.log(`📚 Looking up conversation: ${conversationId}`);
    const conversation = await getConversation(client, tenant, conversationId);

    if (!conversation) {
      console.log(`⚠️  Conversation not found: ${conversationId}`);
      console.log(`   Tenant: ${tenant}`);
      process.exit(1);
    }

    console.log(`✅ Found conversation:`);
    console.log(`   ID: ${conversation.conversation_id}`);
    console.log(`   Participants: ${(conversation.participant_ids || []).join(', ')}`);
    console.log(`   Created: ${conversation.created_at}`);
    console.log(`   Last Event: ${conversation.last_event_at}`);
    console.log(`   Status: ${conversation.status}`);
    console.log('');

    // Get associated events if needed
    let events = [];
    if (includeEvents) {
      console.log(`🔍 Looking up associated ChatEvents...`);
      events = await getChatEvents(client, tenant, conversationId);
      console.log(`✅ Found ${events.length} ChatEvent(s)\n`);
    }

    // Show what will be deleted
    console.log('📋 Summary:');
    console.log(`   Will delete: 1 Conversation`);
    if (includeEvents) {
      console.log(`   Will delete: ${events.length} ChatEvent(s)`);
    }
    console.log('');

    if (dryRun) {
      console.log('🔍 DRY RUN MODE - No deletions will be performed\n');
      console.log('Would delete:');
      console.log(`  - Conversation: ${conversation.conversation_id} (UUID: ${conversation._additional.id})`);
      if (includeEvents && events.length > 0) {
        console.log(`  - ChatEvents:`);
        events.forEach((event, index) => {
          console.log(`    ${index + 1}. ${event.event_id} (${event.event_type}) - UUID: ${event._additional.id}`);
        });
      }
      process.exit(0);
    }

    // Confirm deletion
    if (!force) {
      console.log('⚠️  WARNING: This action cannot be undone!');
      const confirmed = await promptConfirmation('Are you sure you want to delete this conversation? (yes/no): ');
      
      if (!confirmed) {
        console.log('❌ Deletion cancelled');
        process.exit(0);
      }
      console.log('');
    }

    // Delete events first (if included)
    if (includeEvents && events.length > 0) {
      console.log(`🗑️  Deleting ${events.length} ChatEvent(s)...`);
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        try {
          await deleteChatEvent(client, tenant, event._additional.id);
          console.log(`   ✅ Deleted ChatEvent ${i + 1}/${events.length}: ${event.event_id}`);
        } catch (error) {
          console.error(`   ❌ Failed to delete ChatEvent ${event.event_id}:`, error.message);
        }
      }
      console.log('');
    }

    // Delete conversation
    console.log(`🗑️  Deleting Conversation...`);
    try {
      await deleteConversation(client, tenant, conversation._additional.id);
      console.log(`✅ Successfully deleted conversation: ${conversationId}`);
      console.log('');
      console.log('✨ Deletion complete!');
    } catch (error) {
      console.error(`❌ Failed to delete conversation:`, error.message);
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response, null, 2));
    }
    process.exit(1);
  }
}

main();


