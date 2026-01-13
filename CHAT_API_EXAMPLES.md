# Chat API Examples

This document provides curl examples for the Chat API endpoints.

## Prerequisites

All endpoints require JWT authentication. Your JWT token must contain an `agentCode` field.

```bash
# Example JWT token (you'll need to generate your own)
TOKEN="your-jwt-token-here"
BASE_URL="http://localhost:3003"  # or your production URL
```

## 1. Get User Conversations

Get conversation room list for a user (sorted by newest date).

**Endpoint:** `GET /api/v1/platform/chat/conversations`

**Query Parameters:**
- `userIdentifier` (required) - User phone number (e.g., "6282121547121")
- `limit` (optional) - Number of results (default: 20, max: 100)
- `offset` (optional) - Pagination offset (default: 0)

**Example:**
```bash
curl -X GET "${BASE_URL}/api/v1/platform/chat/conversations?userIdentifier=6282121547121&limit=20&offset=0" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "success": true,
  "conversations": [
    {
      "conversationId": "javear-client-wpp-4:6282121547121",
      "clientId": "javear-client-wpp-4",
      "platform": "wpp",
      "participantIds": ["6282121547121", "ginka-transaction-agent"],
      "createdAt": "2026-01-13T02:00:00.000Z",
      "lastEventAt": "2026-01-13T09:16:09.000Z",
      "lastEventType": "ai:response",
      "lastEventContent": [{"type": "text", "text": "Halo, Jav! Ada yang bisa saya bantu hari ini?"}],
      "lastSenderType": "ai:agent",
      "lastSenderId": "ginka-transaction-agent",
      "lastSenderDisplayName": "ginka-transaction-agent",
      "status": "open"
    }
  ],
  "pagination": {
    "total": 1,
    "limit": 20,
    "offset": 0,
    "hasMore": false
  }
}
```

## 2. Get Conversation Chats

Get chat messages in a conversation (sorted by newest date).

**Endpoint:** `GET /api/v1/platform/chat/conversations/:conversationId/chats`

**Path Parameters:**
- `conversationId` (required) - Format: "clientId:userIdentifier" (e.g., "javear-client-wpp-4:6282121547121")

**Query Parameters:**
- `limit` (optional) - Number of results (default: 50, max: 100)
- `offset` (optional) - Pagination offset (default: 0)

**Example:**
```bash
curl -X GET "${BASE_URL}/api/v1/platform/chat/conversations/javear-client-wpp-4:6282121547121/chats?limit=50&offset=0" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "success": true,
  "conversationId": "javear-client-wpp-4:6282121547121",
  "chats": [
    {
      "eventId": "api-1768270493184",
      "eventType": "ai:response",
      "senderType": "ai:agent",
      "senderId": "ginka-transaction-agent",
      "senderDisplayName": "ginka-transaction-agent",
      "senderAvatarUrl": null,
      "content": [{"type": "text", "text": "Halo, Jav! Ada yang bisa saya bantu hari ini?"}],
      "sequence": 1768270493184,
      "createdAt": "2026-01-13T09:16:09.000Z",
      "visibility": "visible"
    },
    {
      "eventId": "false_6282121547121@c.us_3B97D28A50E9F932D392",
      "eventType": "message:incoming",
      "senderType": "user",
      "senderId": "6282121547121",
      "senderDisplayName": "6282121547121",
      "senderAvatarUrl": null,
      "content": [{"type": "text", "text": "halo"}],
      "sequence": 1768270493000,
      "createdAt": "2026-01-13T09:16:09.000Z",
      "visibility": "visible"
    }
  ],
  "pagination": {
    "total": 2,
    "limit": 50,
    "offset": 0,
    "hasMore": false
  }
}
```

## 3. Post Chat Message

Post a message to a conversation. The message will be published to the stream and sent by the consumer.

**Endpoint:** `POST /api/v1/platform/chat/conversations/:conversationId/messages`

**Path Parameters:**
- `conversationId` (required) - Format: "clientId:userIdentifier" (e.g., "javear-client-wpp-4:6282121547121")

**Request Body:**
```json
{
  "content": "Hello! This is a test message from the API",
  "messageType": "text"
}
```

**Example:**
```bash
curl -X POST "${BASE_URL}/api/v1/platform/chat/conversations/javear-client-wpp-4:6282121547121/messages" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Hello! This is a test message from the API",
    "messageType": "text"
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Chat message published to stream - will be sent by consumer",
  "data": {
    "conversationId": "javear-client-wpp-4:6282121547121",
    "messageId": "api-1768271234567-abc123",
    "content": "Hello! This is a test message from the API",
    "messageType": "text",
    "entryId": "1768271234567-0",
    "publishedAt": "2026-01-13T09:20:34.567Z"
  }
}
```

## Complete Example Script

```bash
#!/bin/bash

# Configuration
TOKEN="your-jwt-token-here"
BASE_URL="http://localhost:3003"
USER_IDENTIFIER="6282121547121"
CLIENT_ID="javear-client-wpp-4"
CONVERSATION_ID="${CLIENT_ID}:${USER_IDENTIFIER}"

# 1. Get user conversations
echo "📋 Getting conversations for user ${USER_IDENTIFIER}..."
curl -X GET "${BASE_URL}/api/v1/platform/chat/conversations?userIdentifier=${USER_IDENTIFIER}&limit=20&offset=0" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" | jq '.'

echo -e "\n"

# 2. Get chats in conversation
echo "💬 Getting chats for conversation ${CONVERSATION_ID}..."
curl -X GET "${BASE_URL}/api/v1/platform/chat/conversations/${CONVERSATION_ID}/chats?limit=50&offset=0" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" | jq '.'

echo -e "\n"

# 3. Post a message
echo "📤 Posting message to conversation ${CONVERSATION_ID}..."
curl -X POST "${BASE_URL}/api/v1/platform/chat/conversations/${CONVERSATION_ID}/messages" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Hello! This is a test message from the API",
    "messageType": "text"
  }' | jq '.'

echo -e "\n"
```

## Notes

1. **JWT Token Requirements:**
   - Must contain `agentCode` field (required for tenant scoping)
   - Token is used to determine which agent's conversations to query

2. **Conversation ID Format:**
   - Format: `"clientId:userIdentifier"`
   - Example: `"javear-client-wpp-4:6282121547121"`
   - The `userIdentifier` is the phone number (without @c.us suffix)

3. **Pagination:**
   - Use `limit` and `offset` for pagination
   - Results are sorted by newest first
   - `hasMore` indicates if there are more results

4. **Message Posting:**
   - Message is published to stream immediately
   - Consumer (WPP/WA-Official) will send the message asynchronously
   - Response returns immediately with `entryId` from stream

5. **Platform Support:**
   - Works for both WPP (`platform: 'wpp'`) and WA-Official (`platform: 'wa-official'`)
   - The platform is determined automatically from the `clientId`
