#!/usr/bin/env node

/**
 * Query Weaviate Chat History
 * 
 * Query chat events and conversations from Weaviate based on tenant, user, or conversation
 * 
 * Usage:
 *   node scripts/query-weaviate.js --tenant <agent_code> [options]
 * 
 * Options:
 *   --tenant <agent_code>        Filter by tenant (agent_code) [required]
 *   --conversation <id>          Filter by conversation_id
 *   --user <identifier>          Filter by user identifier (part of conversation_id)
 *   --event-type <type>          Filter by event type (message:incoming, ai:response)
 *   --limit <number>             Limit number of results (default: 50)
 *   --format <json|table>        Output format (default: json)
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

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name, defaultValue = null) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : defaultValue;
};

const tenant = getArg('--tenant');
const conversationId = getArg('--conversation');
const userIdentifier = getArg('--user');
const eventType = getArg('--event-type');
const limit = parseInt(getArg('--limit', '50'));
const format = getArg('--format', 'json');

if (!tenant) {
  console.error('❌ Error: --tenant is required');
  console.log('\nUsage:');
  console.log('  node scripts/query-weaviate.js --tenant <agent_code> [options]');
  console.log('\nOptions:');
  console.log('  --tenant <agent_code>        Filter by tenant (agent_code) [required]');
  console.log('  --conversation <id>          Filter by conversation_id');
  console.log('  --user <identifier>          Filter by user identifier');
  console.log('  --event-type <type>          Filter by event type');
  console.log('  --limit <number>             Limit number of results (default: 50)');
  console.log('  --format <json|table>        Output format (default: json)');
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

// Format output
function formatOutput(data, formatType) {
  if (formatType === 'table') {
    if (data.conversations && data.conversations.length > 0) {
      console.log('\n📋 Conversations:');
      console.table(data.conversations.map(c => {
        // Extract text from last_event_content (JSON string)
        let lastMessage = 'N/A';
        if (c.last_event_content) {
          try {
            const contentArray = typeof c.last_event_content === 'string' 
              ? JSON.parse(c.last_event_content) 
              : c.last_event_content;
            if (Array.isArray(contentArray) && contentArray.length > 0) {
              const firstContent = contentArray[0];
              if (firstContent.text) {
                lastMessage = firstContent.text.substring(0, 50) + (firstContent.text.length > 50 ? '...' : '');
              } else if (firstContent.type) {
                lastMessage = `[${firstContent.type}]`;
              }
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
        
        return {
          conversation_id: c.conversation_id,
          client_id: c.client_id || 'N/A',
          platform: c.platform || 'N/A',
          participants: c.participant_ids?.join(', ') || 'N/A',
          last_sender: c.last_sender_display_name || c.last_sender_id || 'N/A',
          last_message: lastMessage,
          last_event_type: c.last_event_type || 'N/A',
          created_at: c.created_at,
          last_event_at: c.last_event_at,
          status: c.status
        };
      }));
    }
    
    if (data.events && data.events.length > 0) {
      console.log('\n💬 Chat Events:');
      console.table(data.events.map(e => ({
        event_id: e.event_id?.substring(0, 20) + '...',
        event_type: e.event_type,
        sender: `${e.sender_type}:${e.sender_id?.substring(0, 15)}`,
        sequence: e.sequence,
        created_at: e.created_at,
        visibility: e.visibility
      })));
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Query conversations
async function queryConversations(client, tenant, conversationIdFilter, userFilter) {
  const whereConditions = [];

  if (conversationIdFilter) {
    whereConditions.push({
      path: ['conversation_id'],
      operator: 'Equal',
      valueString: conversationIdFilter
    });
  } else if (userFilter) {
    // Search for conversations containing the user identifier
    whereConditions.push({
      path: ['conversation_id'],
      operator: 'Like',
      valueString: `*${userFilter}*`
    });
  }

  const where = whereConditions.length === 1 
    ? whereConditions[0]
    : whereConditions.length > 1
    ? { operator: 'And', operands: whereConditions }
    : undefined;

  const query = client.graphql
    .get()
    .withClassName('Conversation')
    .withTenant(tenant)
    .withFields('conversation_id client_id platform title participant_ids created_at last_event_at last_event_id last_event_type last_event_content last_sender_type last_sender_id last_sender_display_name status metadata')
    .withLimit(limit);

  if (where) {
    query.withWhere(where);
  }

  try {
    const result = await query
      .withSort([{ path: ['last_event_at'], order: 'desc' }])
      .do();

    return result.data?.Get?.Conversation || [];
  } catch (error) {
    // If tenant doesn't exist, return empty array
    if (error.message && error.message.includes('tenant not found')) {
      return [];
    }
    throw error;
  }
}

// Query chat events
async function queryChatEvents(client, tenant, conversationIdFilter, eventTypeFilter) {
  const whereConditions = [];

  if (conversationIdFilter) {
    whereConditions.push({
      path: ['conversation_id'],
      operator: 'Equal',
      valueString: conversationIdFilter
    });
  }

  if (eventTypeFilter) {
    whereConditions.push({
      path: ['event_type'],
      operator: 'Equal',
      valueString: eventTypeFilter
    });
  }

  const where = whereConditions.length === 1 
    ? whereConditions[0]
    : whereConditions.length > 1
    ? { operator: 'And', operands: whereConditions }
    : undefined;

  // Try content field first, fallback to payload for backward compatibility
  let events = [];
  const baseFields = 'conversation_id event_id event_type sender_type sender_id sender_display_name sender_role_label sender_avatar_url participant_ids sequence created_at visibility';
  
  try {
    // Try with content field (new schema)
    const query = client.graphql
      .get()
      .withClassName('ChatEvent')
      .withTenant(tenant)
      .withFields(`${baseFields} content`)
      .withLimit(limit);

    if (where) {
      query.withWhere(where);
    }

    const result = await query
      .withSort([{ path: ['sequence'], order: 'asc' }])
      .do();

    events = result.data?.Get?.ChatEvent || [];
  } catch (error) {
    // If content field doesn't exist, try with payload (old schema)
    try {
      const query = client.graphql
        .get()
        .withClassName('ChatEvent')
        .withTenant(tenant)
        .withFields(`${baseFields} payload`)
        .withLimit(limit);

      if (where) {
        query.withWhere(where);
      }

      const result = await query
        .withSort([{ path: ['sequence'], order: 'asc' }])
        .do();

      // Map payload to content for backward compatibility
      events = (result.data?.Get?.ChatEvent || []).map(e => ({
        ...e,
        content: e.payload || null
      }));
    } catch (payloadError) {
      // If both fail, query without content/payload
      const query = client.graphql
        .get()
        .withClassName('ChatEvent')
        .withTenant(tenant)
        .withFields(baseFields)
        .withLimit(limit);

      if (where) {
        query.withWhere(where);
      }

      const result = await query
        .withSort([{ path: ['sequence'], order: 'asc' }])
        .do();

      events = (result.data?.Get?.ChatEvent || []).map(e => ({
        ...e,
        content: null
      }));
    }
  }

  return events;
}

// Get full conversation history
async function getConversationHistory(client, tenant, conversationId) {
  // Get conversation
  const conversations = await queryConversations(client, tenant, conversationId, null);
  const conversation = conversations[0];

  if (!conversation) {
    return { conversation: null, events: [] };
  }

  // Get all events for this conversation
  const events = await queryChatEvents(client, tenant, conversationId, null);

  // last_event_content is now stored as object[] in Weaviate, no parsing needed
  return {
    conversation: conversation,
    events: events.map(event => ({
      ...event,
      content: event.content ? JSON.parse(event.content) : []
    }))
  };
}

// Main function
async function main() {
  try {
    console.log('🔍 Connecting to Weaviate...');
    const client = initializeClient();

    // Test connection
    await client.misc.metaGetter().do();
    console.log('✅ Connected to Weaviate\n');

    let result;

    if (conversationId) {
      // Get specific conversation with full history
      console.log(`📚 Fetching conversation: ${conversationId}`);
      try {
        result = await getConversationHistory(client, tenant, conversationId);
        
        if (!result.conversation) {
          console.log(`⚠️  Conversation not found: ${conversationId}`);
          process.exit(1);
        }

        console.log(`✅ Found conversation with ${result.events.length} events\n`);
      } catch (error) {
        if (error.message && error.message.includes('tenant not found')) {
          console.log(`ℹ️  Tenant "${tenant}" does not exist yet (no data has been stored for this tenant).`);
          console.log(`   Conversation "${conversationId}" not found.\n`);
          process.exit(1);
        } else {
          throw error;
        }
      }
    } else {
      // Get conversations and events separately
      console.log(`🔍 Querying tenant: ${tenant}`);
      if (conversationId) console.log(`   Conversation: ${conversationId}`);
      if (userIdentifier) console.log(`   User: ${userIdentifier}`);
      if (eventType) console.log(`   Event Type: ${eventType}`);
      console.log('');

      const conversations = await queryConversations(client, tenant, conversationId, userIdentifier);
      const events = await queryChatEvents(client, tenant, conversationId, eventType);

      if (conversations.length === 0 && events.length === 0) {
        console.log(`ℹ️  Tenant "${tenant}" does not exist yet (no data has been stored for this tenant).`);
        console.log('   This is normal if you just recreated the Conversation class.\n');
      }

      result = {
        conversations: conversations.map(c => ({
          ...c,
          last_event_content: c.last_event_content ? (typeof c.last_event_content === 'string' ? JSON.parse(c.last_event_content) : c.last_event_content) : []
        })),
        events: events.map(e => ({
          ...e,
          content: e.content ? JSON.parse(e.content) : [] // Parse content from JSON string
        }))
      };

      console.log(`✅ Found ${conversations.length} conversation(s) and ${events.length} event(s)\n`);
    }

    formatOutput(result, format);

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response, null, 2));
    }
    process.exit(1);
  }
}

main();

