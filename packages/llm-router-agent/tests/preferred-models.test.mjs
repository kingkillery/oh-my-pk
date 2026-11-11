import assert from 'node:assert/strict';
import test from 'node:test';
import { cloneDefaultConfig, DEFAULT_CONFIG, LLMRouter, PREFERRED_ROUTER_MODELS } from '../dist/index.js';

test('PREFERRED_ROUTER_MODELS exports all 10 target models with metadata', () => {
  const keys = Object.keys(PREFERRED_ROUTER_MODELS);
  assert.equal(keys.length, 10);

  // Kimi
  assert.equal(PREFERRED_ROUTER_MODELS.kimiK31Pro.provider, 'kimi-code');
  assert.equal(PREFERRED_ROUTER_MODELS.kimiK31Pro.modelId, 'k3.1-pro');
  assert.equal(PREFERRED_ROUTER_MODELS.kimiK31Pro.selector, 'kimi-code/k3.1-pro');

  // Minimax
  assert.equal(PREFERRED_ROUTER_MODELS.minimaxM31Flash.provider, 'minimax-code');
  assert.equal(PREFERRED_ROUTER_MODELS.minimaxM31Flash.modelId, 'MiniMax-M3.1-Flash');
  assert.equal(PREFERRED_ROUTER_MODELS.minimaxM31Flash.contextWindow, 1_000_000);

  // OpenRouter suite
  assert.equal(PREFERRED_ROUTER_MODELS.deepseekV41Flash.selector, 'openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.equal(PREFERRED_ROUTER_MODELS.flintFree.selector, 'openrouter/recursive/flint-v1.0:free');
  assert.equal(PREFERRED_ROUTER_MODELS.ernieFlashFree.selector, 'openrouter/baidu/ernie-5.5-flash-preview:free');
  assert.equal(PREFERRED_ROUTER_MODELS.nemotronUltraFree.selector, 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.equal(PREFERRED_ROUTER_MODELS.dots3NoteFree.selector, 'openrouter/dots-studio/dots-3-note-preview:free');

  // Antigravity
  assert.equal(PREFERRED_ROUTER_MODELS.gemini38FlashTiered.selector, 'google-antigravity/gemini-3.8-flash-tiered');

  // OpenAI Codex
  assert.equal(PREFERRED_ROUTER_MODELS.gpt6Luna.selector, 'openai-codex/gpt-6-luna');
  assert.equal(PREFERRED_ROUTER_MODELS.gpt61Terra.selector, 'openai-codex/gpt-6.1-terra');
});

test('DEFAULT_CONFIG model profiles use preferred models and valid fallback chains', () => {
  const config = cloneDefaultConfig();

  // Fast lane uses deepseek-v4.1-flash-1017
  assert.equal(config.models.fast.selector, 'openrouter/deepseek/deepseek-v4.1-flash-1017');

  // Coding lane uses Kimi K3.1 Pro
  assert.equal(config.models.coding.selector, 'kimi-code/k3.1-pro');

  // Quality lane uses GPT-6.1 Terra
  assert.equal(config.models.quality.selector, 'openai-codex/gpt-6.1-terra');

  // Balanced lane uses Minimax M3.1 Flash
  assert.equal(config.models.balanced.selector, 'minimax-code/MiniMax-M3.1-Flash');

  // Multimodal lane uses Gemini 3.8 Flash Tiered
  assert.equal(config.models.multimodal.selector, 'google-antigravity/gemini-3.8-flash-tiered');

  // Free lane uses Nemotron 3 Ultra Free
  assert.equal(config.models.free.selector, 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free');
});

test('LLMRouter routes coding requests to Kimi K3.1 Pro', () => {
  const router = new LLMRouter(cloneDefaultConfig());
  const decision = router.decide({
    message: 'Write a full TypeScript implementation of a LRU cache with comprehensive tests and generics.',
  });
  assert.equal(decision.selectedModel, 'coding');
  assert.equal(decision.selector, 'kimi-code/k3.1-pro');
});

test('LLMRouter routes high-quality/safety requests to GPT-6.1 Terra', () => {
  const router = new LLMRouter(cloneDefaultConfig());
  const decision = router.decide({
    message: 'Audit this authentication controller for cryptographic vulnerabilities and security authorization bypasses.',
    metadata: { stepContext: { stepRisk: 'high', irreversible: true } },
  });
  assert.equal(decision.selectedModel, 'safe');
  assert.equal(decision.selector, 'openai-codex/gpt-6.1-terra');
});
