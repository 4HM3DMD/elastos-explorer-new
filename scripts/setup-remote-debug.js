#!/usr/bin/env node

/**
 * 远程调试配置脚本
 * 用于快速切换不同的远程后端环境
 */

const fs = require('fs');
const path = require('path');

const environments = {
  local: {
    VITE_API_BASE_URL: 'http://localhost:4000/api/v1',
    VITE_BACKEND_URL: 'http://localhost:4000',
    VITE_API_TIMEOUT: '10000',
    VITE_NODE_ENV: 'development'
  },
  staging: {
    VITE_API_BASE_URL: 'https://staging-ela-browser.com/api/v1',
    VITE_BACKEND_URL: 'https://staging-ela-browser.com',
    VITE_API_TIMEOUT: '15000',
    VITE_NODE_ENV: 'staging'
  },
  production: {
    VITE_API_BASE_URL: 'https://ela-browser.com/api/v1',
    VITE_BACKEND_URL: 'https://ela-browser.com',
    VITE_API_TIMEOUT: '15000',
    VITE_NODE_ENV: 'production'
  },
  custom: {
    // 用户可以自定义
    VITE_API_BASE_URL: process.env.CUSTOM_API_URL || 'http://your-remote-server.com/api/v1',
    VITE_BACKEND_URL: process.env.CUSTOM_BACKEND_URL || 'http://your-remote-server.com',
    VITE_API_TIMEOUT: '15000',
    VITE_NODE_ENV: 'development'
  }
};

function createEnvFile(envName) {
  const config = environments[envName];
  if (!config) {
    console.error(`❌ 未知环境: ${envName}`);
    console.log('可用环境:', Object.keys(environments).join(', '));
    process.exit(1);
  }

  const envContent = Object.entries(config)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const envPath = path.join(__dirname, '..', '.env.development');
  
  try {
    fs.writeFileSync(envPath, `# 自动生成的环境配置 - ${envName}\n# 生成时间: ${new Date().toISOString()}\n\n${envContent}\n`);
    console.log(`✅ 已配置 ${envName} 环境`);
    console.log(`📝 配置文件: ${envPath}`);
    console.log('\n📋 当前配置:');
    Object.entries(config).forEach(([key, value]) => {
      console.log(`   ${key}=${value}`);
    });
    console.log('\n🚀 现在可以运行: pnpm dev');
  } catch (error) {
    console.error('❌ 创建配置文件失败:', error.message);
    process.exit(1);
  }
}

// 命令行参数处理
const envName = process.argv[2] || 'local';

console.log(`🔧 配置远程调试环境: ${envName}`);
createEnvFile(envName);
