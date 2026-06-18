/**
 * Versah EstoqueControl — Backend
 * Node.js + Express + PostgreSQL + JWT
 * ─────────────────────────────────────
 * Rotas:
 *   POST   /api/auth/cadastro       — cria conta
 *   POST   /api/auth/login          — autentica e devolve JWT
 *   GET    /api/auth/me             — retorna dados do usuário logado
 *
 *   GET    /api/estoque             — lista itens do usuário logado
 *   POST   /api/estoque             — cria item
 *   PUT    /api/estoque/:id         — edita item
 *   DELETE /api/estoque/:id         — remove item
 *   POST   /api/estoque/:id/mover   — registra entrada ou saída
 *
 *   GET    /api/historico           — últimas 50 movimentações do usuário
 */

const express   = require('express');
const bcrypt    = require('bcrypt');
const jwt       = require('jsonwebtoken');
const { Pool }  = require('pg');
const cors      = require('cors');

// ── Configuração ──────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_troque_em_producao';
const SALT_ROUNDS = 12;

// ── Conexão com o PostgreSQL ──────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.connect()
  .then(() => console.log('✅ PostgreSQL conectado'))
  .catch(err => { console.error('❌ Falha ao conectar ao banco:', err.message); process.exit(1); });

// ── Middlewares globais ───────────────────────────────────
app.use(cors({ origin: '*' }));   // em produção: restrinja ao domínio do frontend
app.use(express.json());

// ── Middleware de autenticação JWT ────────────────────────
function autenticar(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ erro: 'Token não fornecido.' });

  const token = header.slice(7);
  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado.' });
  }
}

// ─────────────────────────────────────────────────────────
// AUTH — Cadastro
// ─────────────────────────────────────────────────────────
app.post('/api/auth/cadastro', async (req, res) => {
  const { nome, email, senha } = req.body;

  if (!nome || !email || !senha)
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios.' });

  if (senha.length < 8)
    return res.status(400).json({ erro: 'A senha deve ter no mínimo 8 caracteres.' });

  try {
    const emailJaExiste = await pool.query(
      'SELECT id FROM usuarios WHERE email = $1', [email.toLowerCase()]
    );
    if (emailJaExiste.rows.length > 0)
      return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });

    const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);

    const result = await pool.query(
      'INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1, $2, $3) RETURNING id, nome, email',
      [nome.trim(), email.toLowerCase().trim(), senhaHash]
    );

    const usuario = result.rows[0];
    const token   = jwt.sign({ id: usuario.id, email: usuario.email }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ token, usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email } });
  } catch (err) {
    console.error('Erro no cadastro:', err);
    res.status(500).json({ erro: 'Erro interno ao criar conta.' });
  }
});

// ─────────────────────────────────────────────────────────
// AUTH — Login
// ─────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha)
    return res.status(400).json({ erro: 'E-mail e senha são obrigatórios.' });

  try {
    const result = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]
    );

    if (result.rows.length === 0)
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });

    const usuario = result.rows[0];
    const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);

    if (!senhaCorreta)
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });

    const token = jwt.sign({ id: usuario.id, email: usuario.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email } });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ erro: 'Erro interno ao autenticar.' });
  }
});

// ─────────────────────────────────────────────────────────
// AUTH — Dados do usuário logado
// ─────────────────────────────────────────────────────────
app.get('/api/auth/me', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nome, email, criado_em FROM usuarios WHERE id = $1', [req.usuario.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno.' });
  }
});

// ─────────────────────────────────────────────────────────
// ESTOQUE — Listar itens do usuário logado
// ─────────────────────────────────────────────────────────
app.get('/api/estoque', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nome, atual, minimo, ideal FROM estoque_items WHERE usuario_id = $1 ORDER BY nome',
      [req.usuario.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar estoque:', err);
    res.status(500).json({ erro: 'Erro ao carregar estoque.' });
  }
});

// ─────────────────────────────────────────────────────────
// ESTOQUE — Criar item
// ─────────────────────────────────────────────────────────
app.post('/api/estoque', autenticar, async (req, res) => {
  const { nome, atual, minimo, ideal } = req.body;

  if (!nome || atual == null || minimo == null || ideal == null)
    return res.status(400).json({ erro: 'Campos obrigatórios: nome, atual, minimo, ideal.' });

  if ([atual, minimo, ideal].some(v => isNaN(v) || v < 0))
    return res.status(400).json({ erro: 'Valores numéricos devem ser ≥ 0.' });

  if (ideal < minimo)
    return res.status(400).json({ erro: 'Estoque ideal deve ser maior ou igual ao mínimo.' });

  try {
    const result = await pool.query(
      `INSERT INTO estoque_items (usuario_id, nome, atual, minimo, ideal)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, atual, minimo, ideal`,
      [req.usuario.id, nome.trim(), atual, minimo, ideal]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao criar item:', err);
    res.status(500).json({ erro: 'Erro ao criar item.' });
  }
});

// ─────────────────────────────────────────────────────────
// ESTOQUE — Editar item
// ─────────────────────────────────────────────────────────
app.put('/api/estoque/:id', autenticar, async (req, res) => {
  const { nome, atual, minimo, ideal } = req.body;
  const itemId = parseInt(req.params.id);

  if (!nome || atual == null || minimo == null || ideal == null)
    return res.status(400).json({ erro: 'Campos obrigatórios: nome, atual, minimo, ideal.' });

  if (ideal < minimo)
    return res.status(400).json({ erro: 'Estoque ideal deve ser maior ou igual ao mínimo.' });

  try {
    // WHERE usuario_id = $5 garante que o dono não edite item de outro usuário
    const result = await pool.query(
      `UPDATE estoque_items
       SET nome = $1, atual = $2, minimo = $3, ideal = $4, atualizado_em = NOW()
       WHERE id = $5 AND usuario_id = $6
       RETURNING id, nome, atual, minimo, ideal`,
      [nome.trim(), atual, minimo, ideal, itemId, req.usuario.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ erro: 'Item não encontrado ou sem permissão.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao editar item:', err);
    res.status(500).json({ erro: 'Erro ao editar item.' });
  }
});

// ─────────────────────────────────────────────────────────
// ESTOQUE — Remover item
// ─────────────────────────────────────────────────────────
app.delete('/api/estoque/:id', autenticar, async (req, res) => {
  const itemId = parseInt(req.params.id);
  try {
    const result = await pool.query(
      'DELETE FROM estoque_items WHERE id = $1 AND usuario_id = $2 RETURNING id',
      [itemId, req.usuario.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ erro: 'Item não encontrado ou sem permissão.' });
    res.json({ mensagem: 'Item removido com sucesso.' });
  } catch (err) {
    console.error('Erro ao remover item:', err);
    res.status(500).json({ erro: 'Erro ao remover item.' });
  }
});

// ─────────────────────────────────────────────────────────
// ESTOQUE — Registrar movimentação (entrada ou saída)
// ─────────────────────────────────────────────────────────
app.post('/api/estoque/:id/mover', autenticar, async (req, res) => {
  const { tipo, quantidade, observacao } = req.body;  // tipo: 'ENTRADA' | 'SAÍDA'
  const itemId = parseInt(req.params.id);

  if (!tipo || !['ENTRADA', 'SAÍDA'].includes(tipo))
    return res.status(400).json({ erro: "tipo deve ser 'ENTRADA' ou 'SAÍDA'." });

  if (!quantidade || quantidade <= 0)
    return res.status(400).json({ erro: 'Quantidade deve ser maior que zero.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Busca o item garantindo que é do usuário logado
    const itemResult = await client.query(
      'SELECT * FROM estoque_items WHERE id = $1 AND usuario_id = $2 FOR UPDATE',
      [itemId, req.usuario.id]
    );
    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Item não encontrado ou sem permissão.' });
    }

    const item  = itemResult.rows[0];
    const delta = tipo === 'ENTRADA' ? quantidade : -quantidade;

    if (tipo === 'SAÍDA' && quantidade > item.atual) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Saída não pode ser maior que o estoque atual.' });
    }

    const novoAtual = Math.max(0, item.atual + delta);

    // Atualiza o estoque
    await client.query(
      'UPDATE estoque_items SET atual = $1, atualizado_em = NOW() WHERE id = $2',
      [novoAtual, itemId]
    );

    // Registra no histórico
    await client.query(
      `INSERT INTO historico_movimentacoes (usuario_id, item_id, item_nome, tipo, quantidade, observacao)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.usuario.id, itemId, item.nome, tipo, quantidade, observacao || null]
    );

    await client.query('COMMIT');

    res.json({ id: item.id, nome: item.nome, atual: novoAtual, minimo: item.minimo, ideal: item.ideal });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro na movimentação:', err);
    res.status(500).json({ erro: 'Erro ao registrar movimentação.' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────
// HISTÓRICO — Últimas 50 movimentações do usuário
// ─────────────────────────────────────────────────────────
app.get('/api/historico', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, item_id, item_nome, tipo, quantidade, observacao, criado_em
       FROM historico_movimentacoes
       WHERE usuario_id = $1
       ORDER BY criado_em DESC
       LIMIT 50`,
      [req.usuario.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao carregar histórico:', err);
    res.status(500).json({ erro: 'Erro ao carregar histórico.' });
  }
});

// ─────────────────────────────────────────────────────────
// Healthcheck
// ─────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ─────────────────────────────────────────────────────────
// Inicia o servidor
// ─────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Versah Backend rodando na porta ${PORT}`));
