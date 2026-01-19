import { Router } from 'express';
import { ChatController } from '../controllers/chat.controller';

export function createChatRoutes(chatController: ChatController): Router {
    const router = Router();

    // Chat API Routes
    // GET /api/v1/platform/chat/conversations?userIdentifier=xxx&limit=20&offset=0
    router.get('/conversations', (req, res) => chatController.getUserConversations(req, res));
    
    // GET /api/v1/platform/chat/conversations/:conversationId/chats?limit=50&offset=0
    router.get('/conversations/:conversationId/chats', (req, res) => chatController.getConversationChats(req, res));
    
    // POST /api/v1/platform/chat/conversations/:conversationId/messages
    router.post('/conversations/:conversationId/messages', (req, res) => chatController.postChatMessage(req, res));

    // PUT /api/v1/platform/chat/conversations/:hashedId/:action (block, pause, release, taken)
    router.put('/conversations/:hashedId/:action', (req, res) => chatController.setConversationNeedAttention(req, res));

    return router;
}
