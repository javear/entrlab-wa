#!/bin/bash

# Test WhatsApp Official Webhook Endpoint using cURL
# 
# This script demonstrates how to test the webhook endpoint with proper HMAC-SHA256 signature
# using cURL and OpenSSL for signature generation.
#
# Usage:
#   ./scripts/test-webhook-curl.sh --clientId my-client --appSecret your_app_secret [options]
#
# Options:
#   --clientId       Client ID (required)
#   --appSecret      App secret for HMAC-SHA256 signature (required)
#   --url            Webhook URL (default: http://localhost:3004/webhook/v1/{clientId})
#   --body           JSON body file path (optional, uses sample payload if not provided)
#   --port           Server port (default: 3004)
#   --verify         Also test GET verification (requires verify_token from vault)

set -e

CLIENT_ID=""
APP_SECRET=""
URL=""
BODY_FILE=""
PORT=3004
VERIFY=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --clientId|-c)
      CLIENT_ID="$2"
      shift 2
      ;;
    --appSecret|-s)
      APP_SECRET="$2"
      shift 2
      ;;
    --url|-u)
      URL="$2"
      shift 2
      ;;
    --body|-b)
      BODY_FILE="$2"
      shift 2
      ;;
    --port|-p)
      PORT="$2"
      shift 2
      ;;
    --verify)
      VERIFY=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --clientId, -c      Client ID (required)"
      echo "  --appSecret, -s     App secret for HMAC-SHA256 signature (required)"
      echo "  --url, -u           Webhook URL (default: http://localhost:{port}/webhook/v1/{clientId})"
      echo "  --body, -b          JSON body file path (optional)"
      echo "  --port, -p          Server port (default: 3004)"
      echo "  --verify            Also test GET verification"
      echo "  --help, -h          Show this help"
      echo ""
      echo "Example:"
      echo "  $0 --clientId my-client --appSecret my_app_secret"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Validate required arguments
if [ -z "$CLIENT_ID" ] || [ -z "$APP_SECRET" ]; then
  echo "❌ Error: --clientId and --appSecret are required"
  echo "   Use --help for usage information"
  exit 1
fi

# Set default URL if not provided
if [ -z "$URL" ]; then
  URL="http://localhost:${PORT}/webhook/v1/${CLIENT_ID}"
fi

# Sample payload if body file not provided
if [ -z "$BODY_FILE" ]; then
  BODY_FILE=$(mktemp)
  cat > "$BODY_FILE" << 'EOF'
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WHATSAPP_BUSINESS_ACCOUNT_ID",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550555555",
              "phone_number_id": "PHONE_NUMBER_ID"
            },
            "contacts": [
              {
                "profile": {
                  "name": "John Doe"
                },
                "wa_id": "15551234567"
              }
            ],
            "messages": [
              {
                "from": "15551234567",
                "id": "wamid.HBgNMTU1NTEyMzQ1NjcVAgARGBI",
                "timestamp": "1234567890",
                "text": {
                  "body": "Hello, this is a test message!"
                },
                "type": "text"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
EOF
  echo "📄 Using sample payload (temp file: $BODY_FILE)"
else
  echo "📄 Using payload from: $BODY_FILE"
fi

# Generate HMAC-SHA256 signature
# Note: This uses the exact same method as Meta uses
PAYLOAD_JSON=$(cat "$BODY_FILE")
SIGNATURE=$(echo -n "$PAYLOAD_JSON" | openssl dgst -sha256 -hmac "$APP_SECRET" | sed 's/^.* //')
SIGNATURE_HEADER="sha256=${SIGNATURE}"

echo ""
echo "🧪 WhatsApp Official Webhook Test (cURL)"
echo "=========================================="
echo ""
echo "📤 Sending POST request..."
echo "   URL: $URL"
echo "   Client ID: $CLIENT_ID"
echo "   Signature: ${SIGNATURE_HEADER:0:30}..."
echo ""

# Send POST request
echo "📥 Response:"
curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIGNATURE_HEADER" \
  -d @"$BODY_FILE" \
  -w "\n\nStatus: %{http_code}\n" \
  -v

# Cleanup temp file if we created it
if [[ "$BODY_FILE" == /tmp/tmp.* ]]; then
  rm -f "$BODY_FILE"
fi

echo ""
echo "✅ Test completed!"
echo ""
echo "Note: For GET verification test, use:"
echo "  curl \"$URL?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=test123\""



