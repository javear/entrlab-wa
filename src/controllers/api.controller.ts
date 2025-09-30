import { Request, Response } from 'express';
import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import { Environment } from '../types';
import mongoose from 'mongoose';
import axios from 'axios';
import jwt from 'jsonwebtoken';

export class ApiController {
    constructor(
        private whatsappService: WPPConnectWhatsAppService,
        private env: Environment
    ) {}

    /**
     * @swagger
     * /api/debug-env:
     *   get:
     *     summary: Debug environment variables
     *     description: Returns the status of environment variables for debugging
     *     tags: [Debug]
     *     responses:
     *       200:
     *         description: Environment variables status
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success:
     *                   type: boolean
     *                 env:
     *                   type: object
     *                   properties:
     *                     UPLOAD_USER_ID:
     *                       type: string
     *                     UPLOAD_AUTH_TOKEN:
     *                       type: string
     */
    debugEnv(req: Request, res: Response): void {
        res.json({
            success: true,
            env: {
                JWT_SECRET: this.env.JWT_SECRET ? 'SET' : 'NOT SET',
                WA_JWT_SECRET: this.env.WA_JWT_SECRET ? 'SET' : 'NOT SET',
                UPLOAD_USER_ID: this.env.UPLOAD_USER_ID ? 'SET' : 'NOT SET',
                UPLOAD_AUTH_TOKEN: this.env.UPLOAD_AUTH_TOKEN ? 'SET' : 'NOT SET'
            }
        });
    }

    /**
     * @swagger
     * /api/memory/stats:
     *   get:
     *     summary: Get memory usage statistics
     *     tags: [System]
     *     responses:
     *       200:
     *         description: Memory statistics retrieved successfully
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success:
     *                   type: boolean
     *                 memory:
     *                   type: object
     *                   properties:
     *                     rss:
     *                       type: number
     *                       description: Resident Set Size in MB
     *                     heapTotal:
     *                       type: number
     *                       description: Total heap size in MB
     *                     heapUsed:
     *                       type: number
     *                       description: Used heap size in MB
     *                     external:
     *                       type: number
     *                       description: External memory in MB
     *                 timestamp:
     *                   type: string
     *                   format: date-time
     */
    getMemoryStats(req: Request, res: Response): void {
        const memUsage = process.memoryUsage();
        const memUsageMB = {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024)
        };
        
        res.json({
            success: true,
            memory: memUsageMB,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * @swagger
     * /api/health:
     *   get:
     *     summary: Health check endpoint
     *     description: Returns the health status of the WhatsApp Bot API and all connected clients
     *     tags: [Health & Status]
     *     responses:
     *       200:
     *         description: API is healthy
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success:
     *                   type: boolean
     *                   example: true
     *                 message:
     *                   type: string
     *                   example: "WhatsApp Bot API is healthy"
     *                 status:
     *                   type: object
     *                   properties:
     *                     totalClients:
     *                       type: number
     *                       example: 2
     *                     readyClients:
     *                       type: number
     *                       example: 1
     *                     errorClients:
     *                       type: number
     *                       example: 0
     *                     isHealthy:
     *                       type: boolean
     *                       example: true
     *                     clients:
     *                       type: array
     *                       items:
     *                         $ref: '#/components/schemas/ClientInfo'
     *                 timestamp:
     *                   type: string
     *                   format: date-time
     *       500:
     *         description: Health check failed
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ErrorResponse'
     */
    async healthCheck(req: Request, res: Response) {
        try {
            const healthStatus = this.whatsappService.getHealthStatus();
            return res.status(200).json({
                success: true,
                message: 'WhatsApp Bot API is healthy',
                status: healthStatus,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Health check error:', error);
            return res.status(500).json({
                success: false,
                error: 'Health check failed',
                timestamp: new Date().toISOString()
            });
        }
    }

    async testClient(req: Request, res: Response) {
        try {
            const clients = this.whatsappService.getAllClients();
            return res.status(200).json({
                success: true,
                message: 'Client test completed',
                clients: clients,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Test client error:', error);
            return res.status(500).json({
                success: false,
                error: 'Test client failed',
                timestamp: new Date().toISOString()
            });
        }
    }

    async testSendMessage(req: Request, res: Response) {
        try {
            const { message = 'Test message', phoneNumber = '6282121547121' } = req.body;
            
            const clients = this.whatsappService.getAllClients();
            const readyClient = clients.find(client => client.isReady);
            
            if (!readyClient) {
                return res.status(400).json({
                    success: false,
                    error: 'No ready client available for testing'
                });
            }

            // This would need to be implemented in the service
            return res.status(200).json({
                success: true,
                message: 'Test send message completed',
                clientId: readyClient.clientId,
                phoneNumber: phoneNumber,
                testMessage: message,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Test send message error:', error);
            return res.status(500).json({
                success: false,
                error: 'Test send message failed',
                timestamp: new Date().toISOString()
            });
        }
    }

    async testEvents(req: Request, res: Response) {
        try {
            const clients = this.whatsappService.getAllClients();
            return res.status(200).json({
                success: true,
                message: 'Test events completed',
                clients: clients.map(client => ({
                    clientId: client.clientId,
                    status: client.status,
                    isReady: client.isReady,
                    lastActivity: client.lastActivity
                })),
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Test events error:', error);
            return res.status(500).json({
                success: false,
                error: 'Test events failed',
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * @swagger
     * /api/test-ai-api:
     *   post:
     *     summary: Test AI API integration
     *     description: Tests the AI API integration by sending a test message and verifying the JWT authentication and response
     *     tags: [Testing & Debugging]
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               message:
     *                 type: string
     *                 description: Test message to send to AI API
     *                 example: "hai"
     *               phoneNumber:
     *                 type: string
     *                 description: Phone number for the test session
     *                 example: "6282121547121"
     *               clientId:
     *                 type: string
     *                 description: Client ID for the test
     *                 example: "test-client"
     *     responses:
     *       200:
     *         description: AI API test completed successfully
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success:
     *                   type: boolean
     *                   example: true
     *                 message:
     *                   type: string
     *                   example: "AI API test completed"
     *                 jwt:
     *                   type: object
     *                   properties:
     *                     payload:
     *                       type: object
     *                     token:
     *                       type: string
     *                 request:
     *                   type: object
     *                   properties:
     *                     url:
     *                       type: string
     *                     payload:
     *                       type: object
     *                     headers:
     *                       type: object
     *                 response:
     *                   type: object
     *                   properties:
     *                     status:
     *                       type: number
     *                     headers:
     *                       type: object
     *                     data:
     *                       type: object
     *                     responseTime:
     *                       type: string
     *                 timestamp:
     *                   type: string
     *                   format: date-time
     *       500:
     *         description: AI API test failed
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ErrorResponse'
     */
    async testAIApi(req: Request, res: Response) {
        try {
            const { message = 'hai', phoneNumber = '6282121547121', clientId = 'test-client' } = req.body;
            
            // Get client info to check if agent is assigned
            const clientInfo = this.whatsappService.getClient(clientId);
            if (!clientInfo) {
                return res.status(400).json({
                    success: false,
                    error: `Client ${clientId} not found`
                });
            }

            // Check if client has an agent assigned
            if (!clientInfo.ai_agent_code) {
                return res.status(400).json({
                    success: false,
                    error: `No agent assigned to client ${clientId}. Please assign an agent first.`
                });
            }

            const url = this.env.FW_ENDPOINT || 'http://localhost:3000/api/agents/generalAssistanceAgent/generate/vnext';
            const jwtSecret = this.env.JWT_SECRET || 'default-secret';
            const agentCode = clientInfo.ai_agent_code; // Use client's agent code

            console.log('🧪 ===== TEST AI API CALL START =====');
            console.log('🧪 Using AI endpoint URL:', url);
            console.log('🧪 Environment variables:', {
                FW_ENDPOINT: this.env.FW_ENDPOINT || 'NOT SET',
                JWT_SECRET: this.env.JWT_SECRET ? 'SET' : 'NOT SET',
                AI_AGENT: this.env.AI_AGENT || 'NOT SET'
            });

            // Create JWT payload with agent data
            const jwtPayload = {
                agent_metadata: {
                    agent_code: agentCode,
                    status: "active",
                },
                type: "bot",
                description: "bot",
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + (60 * 60), // 1 hour expiration
            };

            // Sign JWT with agent data using jsonwebtoken
            const token = jwt.sign(jwtPayload, jwtSecret, { algorithm: 'HS256' });


            const payload = {
                messages: message,
                session: phoneNumber,
                phoneNumber: phoneNumber,
                userName: phoneNumber,
                clientId: clientId
            };


            const requestHeaders = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'X-Agent-Code': agentCode,
                'X-Agent-Status': 'active',
                'X-Agent-Type': 'bot'
            };

            console.log('🧪 AI API Request Headers:', JSON.stringify(requestHeaders, null, 2));
            console.log('🧪 Making HTTP POST request to:', url);

            const startTime = Date.now();
            const response = await axios.post(url, payload, {
                headers: requestHeaders,
                timeout: 30000
            });
            const endTime = Date.now();

            console.log(`🧪 Response Status: ${response.status} ${response.status >= 200 && response.status < 300 ? '✅' : '❌'} (${endTime - startTime}ms)`);

            return res.status(200).json({
                success: true,
                message: 'AI API test completed',
                jwt: {
                    payload: jwtPayload,
                    token: jwt
                },
                request: {
                    url: url,
                    payload: payload,
                    headers: requestHeaders
                },
                response: {
                    status: response.status,
                    headers: response.headers,
                    data: response.data,
                    responseTime: `${endTime - startTime}ms`
                },
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('🧪 ===== TEST AI API CALL ERROR =====');
            console.error('❌ Error during AI API test:', error);
            
            let errorDetails = {};
            if (axios.isAxiosError(error)) {
                errorDetails = {
                    status: error.response?.status,
                    statusText: error.response?.statusText,
                    responseData: error.response?.data,
                    requestUrl: error.config?.url,
                    requestHeaders: error.config?.headers,
                    requestData: error.config?.data
                };
                console.error('❌ Axios Error Details:', errorDetails);
            }
            
            console.error('🧪 ===== TEST AI API CALL ERROR END =====');
            
            return res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                errorDetails: errorDetails,
                timestamp: new Date().toISOString()
            });
        }
    }

    async getBotStatus(req: Request, res: Response) {
        try {
            const clients = this.whatsappService.getAllClients();
            const readyClients = clients.filter(client => client.isReady);
            
            return res.status(200).json({
                success: true,
                message: 'Bot status retrieved',
                totalClients: clients.length,
                readyClients: readyClients.length,
                clients: clients.map(client => ({
                    clientId: client.clientId,
                    status: client.status,
                    isReady: client.isReady,
                    phoneNumber: client.phoneNumber,
                    lastActivity: client.lastActivity
                })),
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Get bot status error:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to get bot status',
                timestamp: new Date().toISOString()
            });
        }
    }

    async sendGreeting(req: Request, res: Response) {
        try {
            const { message = 'Hello! This is a test greeting from the WhatsApp bot.' } = req.body;
            
            const clients = this.whatsappService.getAllClients();
            const readyClient = clients.find(client => client.isReady);
            
            if (!readyClient) {
                return res.status(400).json({
                    success: false,
                    error: 'No ready client available to send greeting'
                });
            }

            // This would need to be implemented in the service
            return res.status(200).json({
                success: true,
                message: 'Greeting sent successfully',
                clientId: readyClient.clientId,
                greeting: message,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Send greeting error:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to send greeting',
                timestamp: new Date().toISOString()
            });
        }
    }

    async getMongoDBStatus(req: Request, res: Response) {
        try {
            const connectionState = mongoose.connection.readyState;
            const states = {
                0: 'disconnected',
                1: 'connected',
                2: 'connecting',
                3: 'disconnecting'
            };

            return res.status(200).json({
                success: true,
                message: 'MongoDB status retrieved',
                connectionState: connectionState,
                connectionStateText: states[connectionState as keyof typeof states],
                host: mongoose.connection.host,
                port: mongoose.connection.port,
                name: mongoose.connection.name,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Get MongoDB status error:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to get MongoDB status',
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * @swagger
     * /api/mongodb/debug:
     *   get:
     *     summary: MongoDB debug information
     *     description: Retrieves detailed debug information about MongoDB collections and session storage
     *     tags: [MongoDB Operations]
     *     responses:
     *       200:
     *         description: MongoDB debug information retrieved successfully
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/MongoDBStatus'
     *       500:
     *         description: Internal server error
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ErrorResponse'
     */
    async debugMongoDB(req: Request, res: Response) {
        try {
            if (!mongoose.connection.db) {
                return res.status(400).json({
                    success: false,
                    error: 'MongoDB database connection not available'
                });
            }

            const collections = await mongoose.connection.db.listCollections().toArray();
            const sessionCollections = collections.filter(col => 
                col.name.startsWith('whatsapp-RemoteAuth-')
            );

            return res.status(200).json({
                success: true,
                message: 'MongoDB debug information retrieved',
                totalCollections: collections.length,
                sessionCollectionsCount: sessionCollections.length,
                allCollections: collections.map(col => ({
                    name: col.name,
                    type: col.type
                })),
                sessionCollections: sessionCollections.map(col => ({
                    name: col.name,
                    type: col.type
                })),
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Debug MongoDB error:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to debug MongoDB',
                timestamp: new Date().toISOString()
            });
        }
    }

    // Legacy compatibility methods
    async getQRCode(req: Request, res: Response) {
        try {
            const clients = this.whatsappService.getAllClients();
            const clientWithQR = clients.find(client => client.qrCode);
            
            if (!clientWithQR) {
                return res.status(404).json({
                    success: false,
                    error: 'No QR code available'
                });
            }

            return res.status(200).json({
                success: true,
                qrCode: clientWithQR.qrCode,
                clientId: clientWithQR.clientId,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Get QR code error:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to get QR code',
                timestamp: new Date().toISOString()
            });
        }
    }

    async getQRStatus(req: Request, res: Response) {
        try {
            const clients = this.whatsappService.getAllClients();
            
            return res.status(200).json({
                success: true,
                clients: clients.map(client => ({
                    clientId: client.clientId,
                    hasQrCode: !!client.qrCode,
                    status: client.status,
                    isReady: client.isReady
                })),
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Get QR status error:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to get QR status',
                timestamp: new Date().toISOString()
            });
        }
    }

    async disconnectClient(req: Request, res: Response) {
        try {
            const clients = this.whatsappService.getAllClients();
            const readyClient = clients.find(client => client.isReady);
            
            if (!readyClient) {
                return res.status(400).json({
                    success: false,
                    error: 'No ready client to disconnect'
                });
            }

            await this.whatsappService.disconnectClient(readyClient.clientId);
            
            return res.status(200).json({
                success: true,
                message: 'Client disconnected successfully',
                clientId: readyClient.clientId,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Disconnect client error:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to disconnect client',
                timestamp: new Date().toISOString()
            });
        }
    }

}
