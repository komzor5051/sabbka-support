#!/usr/bin/env node
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const ai = require('../src/services/ai');
const db = require('../src/services/database');

const QUERIES = [
  'Почему у меня так быстро закончились лимиты?',
  'Не могу войти в аккаунт, ошибка авторизации',
  'Сколько стоит генерация картинок?',
  'Как сделать возврат денег?',
  'Что такое чанки?',
  'Нейросеть обещала сделать файл, но не сделала',
  'Можно ли загрузить файл .py?',
];

async function main() {
  for (const q of QUERIES) {
    const emb = await ai.generateEmbedding(q);
    const results = await db.searchSimilar(emb, 3, null, 0.50);
    const top = results[0];
    const sim = top ? `${Math.round(top.similarity * 100)}%` : 'none';
    const cat = top?.category || '-';
    console.log(`[${sim}] "${q}" → ${cat}`);
  }
}

main().catch(e => console.error(e));
