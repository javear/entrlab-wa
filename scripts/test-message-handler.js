// Test script to verify message handler is working
const { create } = require('@wppconnect-team/wppconnect');

async function testHandler() {
  console.log('🧪 Testing message handler registration...');
  
  const client = await create({
    session: 'test-handler',
    headless: true,
    logQR: true,
  });
  
  console.log('✅ Client created');
  
  // Register handler
  let handlerCalled = false;
  client.onMessage(async (message) => {
    handlerCalled = true;
    console.log('🔔🔔🔔 HANDLER CALLED!', {
      type: message.type,
      from: message.from,
      body: message.body?.substring(0, 50)
    });
  });
  
  console.log('✅ Handler registered');
  console.log('📱 Waiting for messages... (send a test message)');
  console.log('⏰ Will timeout after 60 seconds');
  
  // Wait for handler to be called
  await new Promise(resolve => setTimeout(resolve, 60000));
  
  if (handlerCalled) {
    console.log('✅ TEST PASSED: Handler received messages!');
  } else {
    console.log('❌ TEST FAILED: Handler never received any messages');
  }
  
  await client.close();
  process.exit(handlerCalled ? 0 : 1);
}

testHandler().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
