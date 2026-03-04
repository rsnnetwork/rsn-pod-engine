const http = require('http');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'your-jwt-secret-change-in-production';
const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const TEST_USER_EMAIL = 'test@example.com';

function generateToken(userId = TEST_USER_ID, email = TEST_USER_EMAIL, role = 'member') {
  return jwt.sign(
    { sub: userId, email, role, sessionId: 'test-session' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

async function testAuth() {
  console.log('🚀 RSN Auth & API Test\n');
  console.log('─'.repeat(60) + '\n');
  
  // Generate token
  const token = generateToken();
  console.log('✅ Generated JWT Token:\n');
  console.log(token);
  console.log('\n');
  
  // Test with /api/users/me
  console.log('─'.repeat(60) + '\n');
  console.log('Testing with /api/users/me endpoint...\n');
  
  return new Promise((resolve) => {
    const req = http.request('http://localhost:3001/api/users/me', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.success) {
            console.log('✅ Authentication Successful!\n');
            console.log('User Profile:');
            console.log(`  ID: ${response.data.id}`);
            console.log(`  Email: ${response.data.email}`);
            console.log(`  Display Name: ${response.data.displayName}`);
            console.log(`  Role: ${response.data.role}`);
            console.log(`  Status: ${response.data.status}\n`);
          } else {
            console.log('❌ Request failed:', response.error);
          }
        } catch (e) {
          console.log('Error parsing response:', e.message);
        }
        resolve();
      });
    });
    
    req.on('error', err => {
      console.log('❌ Request error:', err.message);
      resolve();
    });
    
    req.end();
  });
}

async function main() {
  await testAuth();
  
  console.log('─'.repeat(60) + '\n');
  console.log('🎉 Auth Test Complete!\n');
  console.log('Now in Postman:');
  console.log('1. Import RSN-API.postman_collection.json');
  console.log('2. You can manually do the magic link flow:');
  console.log('   - Run "Request Magic Link" (test@example.com)');
  console.log('   - Check server console for token');
  console.log('   - Run "Verify Magic Link" with that token');
  console.log('3. Or use the JWT token from above for testing\n');
}

main().catch(console.error);
