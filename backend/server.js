/**
 * Versah EstoqueControl — Backend
 * Node.js + Express + PostgreSQL + JWT
 * ─────────────────────────────────────
 * Rotas:
 * POST   /api/auth/cadastro       — cria conta
 * POST   /api/auth/login          — autentica e devolve JWT
 * GET    /api/auth/me             — retorna dados do usuário logado
 *
 * GET    /api/estoque             — lista itens do usuário logado
 * POST   /api/estoque             — cria item
 * PUT    /api/estoque/:id         — edita item
 * DELETE /api/estoque/:id         — remove item
 * POST   /api/estoque/:id/mover   — registra entrada ou saída
 *
 * GET    /api/historico           — últimas 50 movimentações do usuário
 *
 * POST   /api/auth/trocar-senha   — troca a própria senha
 * GET    /api/config              — configurações públicas (ex.: autocadastro)
 *
 * Administração (somente is_admin):
 * GET    /api/admin/resumo                      — números gerais do sistema
 * GET    /api/admin/usuarios                    — lista usuários com indicadores
 * POST   /api/admin/usuarios                    — cria usuário com senha provisória
 * PUT    /api/admin/usuarios/:id                — edita nome, e-mail, perfil e status
 * POST   /api/admin/usuarios/:id/redefinir-senha — gera nova senha provisória
 * GET    /api/admin/usuarios/:id/estoque        — itens de estoque do usuário
 * GET    /api/admin/configuracoes               — configurações do sistema
 * PUT    /api/admin/configuracoes               — salva configurações
 */

const express   = require('express');
const bcrypt    = require('bcrypt');
const jwt       = require('jsonwebtoken');
const { Pool }  = require('pg');
const cors      = require('cors');
const crypto    = require('crypto');

// ── Configuração ──────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_troque_em_producao';
const SALT_ROUNDS = 12;
// E-mail que vira administrador automaticamente na inicialização (opcional)
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

// ── Conexão com o PostgreSQL ──────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Migrações: aplicadas a cada inicialização (todas idempotentes) ──
const MIGRACOES = [
  `ALTER TABLE estoque_items ADD COLUMN IF NOT EXISTS categoria VARCHAR(100) NOT NULL DEFAULT 'Sem categoria'`,
  `ALTER TABLE estoque_items ADD COLUMN IF NOT EXISTS unidade VARCHAR(20) NOT NULL DEFAULT 'un'`,
  `ALTER TABLE historico_movimentacoes ADD COLUMN IF NOT EXISTS lote VARCHAR(100)`,
  `ALTER TABLE historico_movimentacoes ADD COLUMN IF NOT EXISTS data_validade DATE`,
  `ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS deve_trocar_senha BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_versao INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_acesso TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS configuracoes (
     id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
     permitir_cadastro BOOLEAN NOT NULL DEFAULT true
   )`,
  `INSERT INTO configuracoes (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
];

async function prepararBanco() {
  for (const sql of MIGRACOES) await pool.query(sql);
  if (ADMIN_EMAIL) {
    const r = await pool.query('UPDATE usuarios SET is_admin = true, ativo = true WHERE email = $1 RETURNING id', [ADMIN_EMAIL]);
    if (r.rowCount) console.log(`👑 ${ADMIN_EMAIL} marcado como administrador`);
    else console.warn(`⚠️  ADMIN_EMAIL=${ADMIN_EMAIL} não corresponde a nenhum usuário cadastrado`);
  }
}

// ── Middlewares globais ───────────────────────────────────
app.use(cors({ origin: '*' }));   // em produção: restrinja ao domínio do frontend
app.use(express.json());

// ── Helpers de usuário/sessão ─────────────────────────────
const COLUNAS_USUARIO = 'id, nome, email, is_admin, ativo, deve_trocar_senha, token_versao';

function gerarToken(usuario) {
  return jwt.sign({ id: usuario.id, email: usuario.email, v: usuario.token_versao }, JWT_SECRET, { expiresIn: '7d' });
}

function usuarioPublico(u) {
  return { id: u.id, nome: u.nome, email: u.email, is_admin: u.is_admin, deve_trocar_senha: u.deve_trocar_senha };
}

// Senha provisória legível (sem 0/O, 1/l/I), sempre com maiúscula e número
function gerarSenhaProvisoria() {
  const letras = 'abcdefghjkmnpqrstuvwxyz', maiusc = 'ABCDEFGHJKLMNPQRSTUVWXYZ', nums = '23456789';
  const todos = letras + maiusc + nums;
  const pick = (abc) => abc[crypto.randomInt(abc.length)];
  const chars = [pick(maiusc), pick(nums), ...Array.from({ length: 8 }, () => pick(todos))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ── Middleware de autenticação JWT ────────────────────────
// Confere o token e o usuário no banco: contas desativadas ou com a senha
// redefinida (token_versao diferente) perdem o acesso imediatamente.
function criarAutenticacao({ permitirTrocaPendente = false } = {}) {
  return async (req, res, next) => {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer '))
      return res.status(401).json({ erro: 'Token não fornecido.' });

    let payload;
    try {
      payload = jwt.verify(header.slice(7), JWT_SECRET);
    } catch {
      return res.status(401).json({ erro: 'Token inválido ou expirado.' });
    }

    try {
      const result = await pool.query(`SELECT ${COLUNAS_USUARIO} FROM usuarios WHERE id = $1`, [payload.id]);
      const usuario = result.rows[0];
      if (!usuario || !usuario.ativo || usuario.token_versao !== (payload.v || 0))
        return res.status(401).json({ erro: 'Sessão encerrada. Entre novamente.' });
      if (usuario.deve_trocar_senha && !permitirTrocaPendente)
        return res.status(403).json({ erro: 'Defina uma nova senha para continuar.', codigo: 'TROCAR_SENHA' });
      req.usuario = usuario;
      next();
    } catch (err) {
      console.error('Erro na autenticação:', err);
      res.status(500).json({ erro: 'Erro interno.' });
    }
  };
}

const autenticar = criarAutenticacao();
const autenticarComTrocaPendente = criarAutenticacao({ permitirTrocaPendente: true });

function exigirAdmin(req, res, next) {
  if (!req.usuario.is_admin) return res.status(403).json({ erro: 'Acesso restrito ao administrador.' });
  next();
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
    const config = await pool.query('SELECT permitir_cadastro FROM configuracoes WHERE id = 1');
    if (config.rows[0] && !config.rows[0].permitir_cadastro)
      return res.status(403).json({ erro: 'O cadastro de novas contas está desativado. Fale com o administrador.' });

    const emailJaExiste = await pool.query(
      'SELECT id FROM usuarios WHERE email = $1', [email.toLowerCase()]
    );
    if (emailJaExiste.rows.length > 0)
      return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });

    const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, ultimo_acesso) VALUES ($1, $2, $3, NOW()) RETURNING ${COLUNAS_USUARIO}`,
      [nome.trim(), email.toLowerCase().trim(), senhaHash]
    );

    const usuario = result.rows[0];
    res.status(201).json({ token: gerarToken(usuario), usuario: usuarioPublico(usuario) });
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
      'SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0)
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });

    const usuario = result.rows[0];
    const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);

    if (!senhaCorreta)
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });

    if (!usuario.ativo)
      return res.status(403).json({ erro: 'Conta desativada. Fale com o administrador.' });

    await pool.query('UPDATE usuarios SET ultimo_acesso = NOW() WHERE id = $1', [usuario.id]);

    res.json({ token: gerarToken(usuario), usuario: usuarioPublico(usuario) });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ erro: 'Erro interno ao autenticar.' });
  }
});

// ─────────────────────────────────────────────────────────
// AUTH — Dados do usuário logado
// ─────────────────────────────────────────────────────────
app.get('/api/auth/me', autenticarComTrocaPendente, (req, res) => {
  res.json(usuarioPublico(req.usuario));
});

// ─────────────────────────────────────────────────────────
// AUTH — Trocar a própria senha (também usada no 1º acesso
// com senha provisória). Encerra as outras sessões.
// ─────────────────────────────────────────────────────────
app.post('/api/auth/trocar-senha', autenticarComTrocaPendente, async (req, res) => {
  const { senha_atual, nova_senha } = req.body;

  if (!senha_atual || !nova_senha)
    return res.status(400).json({ erro: 'Informe a senha atual e a nova senha.' });
  if (nova_senha.length < 8)
    return res.status(400).json({ erro: 'A nova senha deve ter no mínimo 8 caracteres.' });
  if (nova_senha === senha_atual)
    return res.status(400).json({ erro: 'A nova senha deve ser diferente da atual.' });

  try {
    const atual = await pool.query('SELECT senha_hash FROM usuarios WHERE id = $1', [req.usuario.id]);
    if (!(await bcrypt.compare(senha_atual, atual.rows[0].senha_hash)))
      return res.status(400).json({ erro: 'Senha atual incorreta.' });

    const result = await pool.query(
      `UPDATE usuarios SET senha_hash = $1, deve_trocar_senha = false, token_versao = token_versao + 1
       WHERE id = $2 RETURNING ${COLUNAS_USUARIO}`,
      [await bcrypt.hash(nova_senha, SALT_ROUNDS), req.usuario.id]
    );
    const usuario = result.rows[0];
    res.json({ token: gerarToken(usuario), usuario: usuarioPublico(usuario) });
  } catch (err) {
    console.error('Erro ao trocar senha:', err);
    res.status(500).json({ erro: 'Erro ao trocar senha.' });
  }
});

// ─────────────────────────────────────────────────────────
// CONFIG — Configurações públicas (usadas na tela de login)
// ─────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT permitir_cadastro FROM configuracoes WHERE id = 1');
    res.json({ permitir_cadastro: result.rows[0] ? result.rows[0].permitir_cadastro : true });
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
      'SELECT id, nome, atual, minimo, ideal, categoria, unidade FROM estoque_items WHERE usuario_id = $1 ORDER BY nome',
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
  const { nome, atual, minimo, ideal, categoria, unidade } = req.body;

  if (!nome || atual == null || minimo == null || ideal == null)
    return res.status(400).json({ erro: 'Campos obrigatórios: nome, atual, minimo, ideal.' });

  if ([atual, minimo, ideal].some(v => isNaN(v) || v < 0))
    return res.status(400).json({ erro: 'Valores numéricos devem ser ≥ 0.' });

  if (ideal < minimo)
    return res.status(400).json({ erro: 'Estoque ideal deve ser maior ou igual ao mínimo.' });

  const categoriaFinal = (categoria && categoria.trim()) ? categoria.trim() : 'Sem categoria';
  const unidadeFinal   = (unidade && unidade.trim()) ? unidade.trim() : 'un';

  try {
    const result = await pool.query(
      `INSERT INTO estoque_items (usuario_id, nome, atual, minimo, ideal, categoria, unidade)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, nome, atual, minimo, ideal, categoria, unidade`,
      [req.usuario.id, nome.trim(), atual, minimo, ideal, categoriaFinal, unidadeFinal]
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
  const { nome, atual, minimo, ideal, categoria, unidade } = req.body;
  const itemId = parseInt(req.params.id);

  if (!nome || atual == null || minimo == null || ideal == null)
    return res.status(400).json({ erro: 'Campos obrigatórios: nome, atual, minimo, ideal.' });

  if (ideal < minimo)
    return res.status(400).json({ erro: 'Estoque ideal deve ser maior ou igual ao mínimo.' });

  const categoriaFinal = (categoria && categoria.trim()) ? categoria.trim() : 'Sem categoria';
  const unidadeFinal   = (unidade && unidade.trim()) ? unidade.trim() : 'un';

  try {
    // WHERE usuario_id = $8 garante que o dono não edite item de outro usuário
    const result = await pool.query(
      `UPDATE estoque_items
       SET nome = $1, atual = $2, minimo = $3, ideal = $4, categoria = $5, unidade = $6, atualizado_em = NOW()
       WHERE id = $7 AND usuario_id = $8
       RETURNING id, nome, atual, minimo, ideal, categoria, unidade`,
      [nome.trim(), atual, minimo, ideal, categoriaFinal, unidadeFinal, itemId, req.usuario.id]
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
// ESTOQUE — Remover item (e seu histórico de movimentações)
// ─────────────────────────────────────────────────────────
app.delete('/api/estoque/:id', autenticar, async (req, res) => {
  const itemId = parseInt(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Confirma que o item existe e pertence ao usuário logado
    const itemResult = await client.query(
      'SELECT id FROM estoque_items WHERE id = $1 AND usuario_id = $2 FOR UPDATE',
      [itemId, req.usuario.id]
    );
    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Item não encontrado ou sem permissão.' });
    }

    // Remove o histórico de movimentações desse item primeiro
    await client.query(
      'DELETE FROM historico_movimentacoes WHERE item_id = $1 AND usuario_id = $2',
      [itemId, req.usuario.id]
    );

    // Remove o item do estoque
    await client.query(
      'DELETE FROM estoque_items WHERE id = $1 AND usuario_id = $2',
      [itemId, req.usuario.id]
    );

    await client.query('COMMIT');
    res.json({ mensagem: 'Item e histórico removidos com sucesso.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao remover item:', err);
    res.status(500).json({ erro: 'Erro ao remover item.' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────
// ESTOQUE — Registrar movimentação (entrada ou saída)
// ─────────────────────────────────────────────────────────
app.post('/api/estoque/:id/mover', autenticar, async (req, res) => {
  const { tipo, quantidade, observacao, lote, data_validade } = req.body;  // tipo: 'ENTRADA' | 'SAÍDA'
  const itemId = parseInt(req.params.id);

  if (!tipo || !['ENTRADA', 'SAÍDA'].includes(tipo))
    return res.status(400).json({ erro: "tipo deve ser 'ENTRADA' ou 'SAÍDA'." });

  if (!quantidade || quantidade <= 0)
    return res.status(400).json({ erro: 'Quantidade deve ser maior que zero.' });

  // Lote e validade são opcionais, tanto para entrada quanto para saída
  if (data_validade && !/^\d{4}-\d{2}-\d{2}$/.test(data_validade)) {
    return res.status(400).json({ erro: 'Data de validade inválida.' });
  }

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
      `INSERT INTO historico_movimentacoes (usuario_id, item_id, item_nome, tipo, quantidade, observacao, lote, data_validade)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [req.usuario.id, itemId, item.nome, tipo, quantidade, observacao || null, (lote && lote.trim()) || null, data_validade || null]
    );

    await client.query('COMMIT');

    res.json({
      id: item.id,
      nome: item.nome,
      atual: novoAtual,
      minimo: item.minimo,
      ideal: item.ideal,
      categoria: item.categoria,
      unidade: item.unidade
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro na movimentação:', err);
    if (err.code === '42703') {
      return res.status(500).json({ erro: 'As colunas "lote"/"data_validade" ainda não existem na tabela historico_movimentacoes. Rode o ALTER TABLE no Supabase antes de tentar novamente.' });
    }
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
      `SELECT id, item_id, item_nome, tipo, quantidade, observacao, lote,
              TO_CHAR(data_validade, 'YYYY-MM-DD') AS data_validade, criado_em
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
// LOTES — Alerta de lotes vencidos ou vencendo nos próximos 60 dias
// Baseado na data de validade informada nas entradas (não controla
// saldo restante por lote — apenas avisa sobre lotes já recebidos).
// ─────────────────────────────────────────────────────────
app.get('/api/lotes/alertas', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (item_id, lote)
              item_id, item_nome, lote,
              TO_CHAR(data_validade, 'YYYY-MM-DD') AS data_validade
       FROM historico_movimentacoes
       WHERE usuario_id = $1
         AND tipo = 'ENTRADA'
         AND lote IS NOT NULL
         AND data_validade IS NOT NULL
         AND data_validade <= (CURRENT_DATE + INTERVAL '60 days')
       ORDER BY item_id, lote, criado_em DESC`,
      [req.usuario.id]
    );
    result.rows.sort((a, b) => a.data_validade.localeCompare(b.data_validade));
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao carregar alertas de lote:', err);
    res.status(500).json({ erro: 'Erro ao carregar alertas de lote.' });
  }
});

// ─────────────────────────────────────────────────────────
// ADMINISTRAÇÃO
// ─────────────────────────────────────────────────────────
const isEmailValido = (email) => typeof email === 'string' && /^\S+@\S+\.\S+$/.test(email.trim());

app.get('/api/admin/resumo', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM usuarios)                                   AS total_usuarios,
        (SELECT COUNT(*)::int FROM usuarios WHERE ativo)                       AS usuarios_ativos,
        (SELECT COUNT(*)::int FROM usuarios WHERE is_admin)                    AS administradores,
        (SELECT COUNT(*)::int FROM usuarios
          WHERE ultimo_acesso >= NOW() - INTERVAL '7 days')                    AS acessos_7d,
        (SELECT COUNT(*)::int FROM estoque_items)                              AS total_itens,
        (SELECT COUNT(*)::int FROM estoque_items WHERE atual <= minimo)        AS itens_alerta,
        (SELECT COUNT(*)::int FROM historico_movimentacoes
          WHERE criado_em >= NOW() - INTERVAL '30 days')                       AS movimentacoes_30d`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro no resumo admin:', err);
    res.status(500).json({ erro: 'Erro ao carregar resumo.' });
  }
});

app.get('/api/admin/usuarios', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.nome, u.email, u.is_admin, u.ativo, u.deve_trocar_senha, u.criado_em, u.ultimo_acesso,
             COALESCE(e.total_itens, 0)  AS total_itens,
             COALESCE(e.itens_alerta, 0) AS itens_alerta,
             h.ultima_movimentacao
      FROM usuarios u
      LEFT JOIN (
        SELECT usuario_id, COUNT(*)::int AS total_itens,
               COUNT(*) FILTER (WHERE atual <= minimo)::int AS itens_alerta
        FROM estoque_items GROUP BY usuario_id
      ) e ON e.usuario_id = u.id
      LEFT JOIN (
        SELECT usuario_id, MAX(criado_em) AS ultima_movimentacao
        FROM historico_movimentacoes GROUP BY usuario_id
      ) h ON h.usuario_id = u.id
      ORDER BY u.nome`);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar usuários:', err);
    res.status(500).json({ erro: 'Erro ao carregar usuários.' });
  }
});

// Cria a conta com uma senha provisória, exibida uma única vez para o administrador
app.post('/api/admin/usuarios', autenticar, exigirAdmin, async (req, res) => {
  const { nome, email, is_admin } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Informe o nome.' });
  if (!isEmailValido(email))  return res.status(400).json({ erro: 'Informe um e-mail válido.' });

  const senhaProvisoria = gerarSenhaProvisoria();
  try {
    const result = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, is_admin, deve_trocar_senha)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [nome.trim(), email.trim().toLowerCase(), await bcrypt.hash(senhaProvisoria, SALT_ROUNDS), !!is_admin]
    );
    res.status(201).json({ id: result.rows[0].id, senha_provisoria: senhaProvisoria });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });
    console.error('Erro ao criar usuário:', err);
    res.status(500).json({ erro: 'Erro ao criar usuário.' });
  }
});

app.put('/api/admin/usuarios/:id', autenticar, exigirAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { nome, email, is_admin, ativo } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Informe o nome.' });
  if (!isEmailValido(email))  return res.status(400).json({ erro: 'Informe um e-mail válido.' });
  if (id === req.usuario.id && (!ativo || !is_admin))
    return res.status(400).json({ erro: 'Você não pode desativar a própria conta nem remover o seu acesso de administrador.' });

  try {
    // Desativar encerra as sessões abertas (token_versao muda)
    const result = await pool.query(
      `UPDATE usuarios
       SET nome = $1, email = $2, is_admin = $3, ativo = $4,
           token_versao = token_versao + CASE WHEN ativo AND NOT $4 THEN 1 ELSE 0 END
       WHERE id = $5 RETURNING id`,
      [nome.trim(), email.trim().toLowerCase(), !!is_admin, !!ativo, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    res.json({ mensagem: 'Usuário atualizado.' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });
    console.error('Erro ao editar usuário:', err);
    res.status(500).json({ erro: 'Erro ao editar usuário.' });
  }
});

app.post('/api/admin/usuarios/:id/redefinir-senha', autenticar, exigirAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const senhaProvisoria = gerarSenhaProvisoria();
  try {
    const result = await pool.query(
      `UPDATE usuarios SET senha_hash = $1, deve_trocar_senha = true, token_versao = token_versao + 1
       WHERE id = $2 RETURNING id`,
      [await bcrypt.hash(senhaProvisoria, SALT_ROUNDS), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    res.json({ senha_provisoria: senhaProvisoria });
  } catch (err) {
    console.error('Erro ao redefinir senha:', err);
    res.status(500).json({ erro: 'Erro ao redefinir senha.' });
  }
});

app.get('/api/admin/usuarios/:id/estoque', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nome, atual, minimo, ideal, categoria, unidade FROM estoque_items WHERE usuario_id = $1 ORDER BY nome',
      [parseInt(req.params.id)]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao carregar estoque do usuário:', err);
    res.status(500).json({ erro: 'Erro ao carregar estoque.' });
  }
});

app.get('/api/admin/configuracoes', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT permitir_cadastro FROM configuracoes WHERE id = 1');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao carregar configurações.' });
  }
});

app.put('/api/admin/configuracoes', autenticar, exigirAdmin, async (req, res) => {
  const { permitir_cadastro } = req.body;
  if (typeof permitir_cadastro !== 'boolean')
    return res.status(400).json({ erro: 'permitir_cadastro deve ser verdadeiro ou falso.' });
  try {
    const result = await pool.query(
      'UPDATE configuracoes SET permitir_cadastro = $1 WHERE id = 1 RETURNING permitir_cadastro',
      [permitir_cadastro]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar configurações.' });
  }
});

// ─────────────────────────────────────────────────────────
// Healthcheck
// ─────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ─────────────────────────────────────────────────────────
// Inicia o servidor
// ─────────────────────────────────────────────────────────
prepararBanco()
  .then(() => {
    console.log('✅ PostgreSQL conectado');
    app.listen(PORT, () => console.log(`🚀 Versah Backend rodando na porta ${PORT}`));
  })
  .catch(err => { console.error('❌ Falha ao preparar o banco:', err.message); process.exit(1); });