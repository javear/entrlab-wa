#!/usr/bin/env node

/**
 * Secure JWT Token Generator Script
 * 
 * This script generates JWT tokens for API authentication.
 * It should only be run locally by authorized developers.
 * 
 * Usage:
 *   node scripts/generate-token.js [clientId] [agentCode]
 *   node scripts/generate-token.js official-docs-test goa-konsul
 */

require('dotenv/config');

async function generateToken() {
    try {
        // Get JWT secret from environment
        const jwtSecret = process.env.WA_JWT_SECRET;
        if (!jwtSecret) {
            console.error('❌ WA_JWT_SECRET environment variable is required');
            console.error('   Please set WA_JWT_SECRET in your .env file');
            process.exit(1);
        }

        // Parse command line arguments
        const args = process.argv.slice(2);
        const clientId = args[0] || 'test-client';
        const agentCode = args[1] || 'ginka-transaction-agent';

        // Generate payload for WhatsApp API
        const payload = {
            clientId: clientId,
            agentCode: agentCode,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // 24 hours
            role: 'admin',
            name: 'Admin User'
        };

        // Generate token using jsonwebtoken
        const jwt = require('jsonwebtoken');
        const token = jwt.sign(payload, jwtSecret, { algorithm: 'HS256' });

        console.log('🔐 JWT Token Generated Successfully!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        console.log('📋 Token:');
        console.log(token);
        console.log('');
        console.log('📋 Payload:');
        console.log(JSON.stringify(payload, null, 2));
        console.log('');
        console.log('🔧 Usage:');
        console.log(`curl -H "Authorization: Bearer ${token}" \\`);
        console.log('     "http://localhost:3003/api/health"');
        console.log('');
        console.log('⚠️  Security Notes:');
        console.log('   • Keep this token secure and do not share it');
        console.log('   • Token expires in 24 hours');
        console.log('   • Generate new tokens as needed');
        console.log('   • Do not commit tokens to version control');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    } catch (error) {
        console.error('❌ Error generating JWT token:', error.message);
        process.exit(1);
    }
}

// Run the script
generateToken();
