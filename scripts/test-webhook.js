#!/usr/bin/env node

/**
 * Test WhatsApp Official Webhook Endpoint
 * 
 * This script sends a test POST request to the webhook endpoint with proper HMAC-SHA256 signature.
 * Per Meta's documentation: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
 * 
 * Usage:
 *   node scripts/test-webhook.js --clientId my-client --appSecret your_app_secret [options]
 * 
 * Options:
 *   --clientId       Client ID (required)
 *   --appSecret      App secret for HMAC-SHA256 signature (required)
 *   --url            Webhook URL (default: http://localhost:3004/webhook/v1/{clientId})
 *   --body           JSON body file path (optional, uses sample payload if not provided)
 *   --port           Server port (default: 3004)
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    clientId: null,
    appSecret: null,
    url: null,
    body: null,
    port: 3004
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
      case '--appSecret':
      case '-s':
        config.appSecret = nextArg;
        i++;
        break;
      case '--url':
      case '-u':
        config.url = nextArg;
        i++;
        break;
      case '--body':
      case '-b':
        config.body = nextArg;
        i++;
        break;
      case '--port':
      case '-p':
        config.port = parseInt(nextArg, 10);
        i++;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: node scripts/test-webhook.js [options]

Options:
  --clientId, -c      Client ID (required)
  --appSecret, -s     App secret for HMAC-SHA256 signature (required)
  --url, -u           Webhook URL (default: http://localhost:{port}/webhook/v1/{clientId})
  --body, -b          JSON body file path (optional, uses sample payload if not provided)
  --port, -p          Server port (default: 3004)
  --help, -h          Show this help message

Example:
  node scripts/test-webhook.js --clientId my-client --appSecret my_app_secret
  node scripts/test-webhook.js -c my-client -s my_app_secret --port 3004 --body ./test-payload.json
        `);
        process.exit(0);
        break;
    }
  }

  return config;
}

/**
 * Generate HMAC-SHA256 signature for webhook payload
 * Per Meta's documentation, this matches what Meta sends in X-Hub-Signature-256 header
 */
function generateSignature(payload, appSecret) {
  const hash = crypto
    .createHmac('sha256', appSecret)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  return `sha256=${hash}`;
}

/**
 * Sample webhook payload (message received)
 */
function getSamplePayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550555555',
                phone_number_id: 'PHONE_NUMBER_ID'
              },
              contacts: [
                {
                  profile: {
                    name: 'John Doe'
                  },
                  wa_id: '15551234567'
                }
              ],
              messages: [
                {
                  from: '15551234567',
                  id: 'wamid.HBgNMTU1NTEyMzQ1NjcVAgARGBI',
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  text: {
                    body: 'Hello, this is a test message!'
                  },
                  type: 'text'
                }
              ]
            },
            field: 'messages'
          }
        ]
      }
    ]
  };
}

/**
 * Send webhook test request
 */
function sendWebhookRequest(config) {
  return new Promise((resolve, reject) => {
    // Get payload
    let payload;
    if (config.body && fs.existsSync(config.body)) {
      try {
        payload = JSON.parse(fs.readFileSync(config.body, 'utf8'));
        console.log(`📄 Loaded payload from: ${config.body}`);
      } catch (error) {
        reject(new Error(`Failed to parse body file: ${error.message}`));
        return;
      }
    } else {
      payload = getSamplePayload();
      console.log('📄 Using sample payload');
    }

    // Generate signature
    const signature = generateSignature(payload, config.appSecret);
    
    // Build URL
    const url = config.url || `http://localhost:${config.port}/webhook/v1/${config.clientId}`;
    const urlObj = new URL(url);

    // Prepare request
    const payloadString = JSON.stringify(payload);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadString),
        'X-Hub-Signature-256': signature
      }
    };

    console.log('\n📤 Sending webhook test request...');
    console.log(`   URL: ${url}`);
    console.log(`   Method: POST`);
    console.log(`   Client ID: ${config.clientId}`);
    console.log(`   Signature: ${signature.substring(0, 20)}...`);
    console.log(`   Payload size: ${payloadString.length} bytes\n`);

    // Choose protocol
    const client = urlObj.protocol === 'https:' ? https : http;

    const req = client.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        console.log(`📥 Response received:`);
        console.log(`   Status: ${res.statusCode} ${res.statusMessage}`);
        console.log(`   Headers:`, res.headers);
        
        if (responseData) {
          try {
            const jsonData = JSON.parse(responseData);
            console.log(`   Body:`, JSON.stringify(jsonData, null, 2));
          } catch (e) {
            console.log(`   Body: ${responseData}`);
          }
        }

        if (res.statusCode === 200) {
          console.log('\n✅ Webhook request successful!');
        } else {
          console.log(`\n❌ Webhook request failed with status ${res.statusCode}`);
        }

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseData
        });
      });
    });

    req.on('error', (error) => {
      console.error(`\n❌ Request error: ${error.message}`);
      reject(error);
    });

    // Send request
    req.write(payloadString);
    req.end();
  });
}

/**
 * Test GET webhook verification
 */
function testWebhookVerification(config) {
  return new Promise((resolve, reject) => {
    const verifyToken = 'test_verify_token'; // This should match what's stored in vault
    const challenge = 'test_challenge_12345';
    const mode = 'subscribe';

    const url = config.url || `http://localhost:${config.port}/webhook/v1/${config.clientId}`;
    const urlObj = new URL(url);
    urlObj.searchParams.set('hub.mode', mode);
    urlObj.searchParams.set('hub.verify_token', verifyToken);
    urlObj.searchParams.set('hub.challenge', challenge);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET'
    };

    console.log('\n🔍 Testing webhook verification (GET)...');
    console.log(`   URL: ${urlObj.toString()}`);
    console.log(`   Verify Token: ${verifyToken}\n`);

    const client = urlObj.protocol === 'https:' ? https : http;

    const req = client.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        console.log(`📥 Response received:`);
        console.log(`   Status: ${res.statusCode} ${res.statusMessage}`);
        console.log(`   Response: ${responseData}`);

        if (res.statusCode === 200 && responseData === challenge) {
          console.log('\n✅ Webhook verification successful!');
        } else {
          console.log(`\n❌ Webhook verification failed (expected 200 with challenge)`);
        }

        resolve({
          statusCode: res.statusCode,
          body: responseData
        });
      });
    });

    req.on('error', (error) => {
      console.error(`\n❌ Request error: ${error.message}`);
      reject(error);
    });

    req.end();
  });
}

// Main execution
async function main() {
  const config = parseArgs();

  // Validate required arguments
  if (!config.clientId || !config.appSecret) {
    console.error('❌ Error: --clientId and --appSecret are required');
    console.error('   Use --help for usage information');
    process.exit(1);
  }

  console.log('🧪 WhatsApp Official Webhook Test Script');
  console.log('==========================================\n');

  try {
    // Test POST webhook (with signature)
    await sendWebhookRequest(config);
    
    // Optionally test GET verification (commented out by default since it needs real verify_token from vault)
    // await testWebhookVerification(config);
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { generateSignature, sendWebhookRequest, testWebhookVerification };



