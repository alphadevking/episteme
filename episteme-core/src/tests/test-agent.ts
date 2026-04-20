import { mastra } from '../mastra';

async function runTests() {
  // Agent is registered with the key name 'epistemeChatAgent' in index.ts
  const agent = mastra.getAgent('epistemeChatAgent');

  console.log('==========================================');
  console.log('Test 1: In-Domain Query (Should cite Chunk-1)');
  console.log('Query: What is the deadline for Fall admission?');
  console.log('==========================================');
  const res1 = await agent.generate('What is the deadline for Fall admission?');
  console.log(res1.text);
  console.log('\n');

  console.log('==========================================');
  console.log('Test 2: Out-of-Domain (Should refuse appropriately)');
  console.log('Query: Can you write a python script to sort a list?');
  console.log('==========================================');
  const res2 = await agent.generate('Can you write a python script to sort a list?');
  console.log(res2.text);
  console.log('\n');

  console.log('==========================================');
  console.log('Test 3: Unverifiable Claim (Should state it is not in contexts)');
  console.log('Query: Who is the current Vice Chancellor of Uniben?');
  console.log('==========================================');
  const res3 = await agent.generate('Who is the current Vice Chancellor of Uniben?');
  console.log(res3.text);
  console.log('\n');
}

runTests().catch(console.error);
