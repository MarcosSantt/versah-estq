-- ──────────────────────────────────────────────────────────
-- Versah EstoqueControl — Schema inicial
-- Executado automaticamente pelo PostgreSQL no primeiro boot
-- ──────────────────────────────────────────────────────────

-- Extensão para UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Tabela de usuários ────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
  id         SERIAL PRIMARY KEY,
  nome       VARCHAR(150)        NOT NULL,
  email      VARCHAR(255) UNIQUE NOT NULL,
  senha_hash TEXT                NOT NULL,
  criado_em  TIMESTAMPTZ         DEFAULT NOW()
);

-- ── Tabela de itens de estoque ────────────────────────────
-- Cada item pertence a um único usuário (isolamento multi-tenant)
CREATE TABLE IF NOT EXISTS estoque_items (
  id           SERIAL PRIMARY KEY,
  usuario_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nome         VARCHAR(200) NOT NULL,
  atual        INTEGER NOT NULL DEFAULT 0,
  minimo       INTEGER NOT NULL DEFAULT 0,
  ideal        INTEGER NOT NULL DEFAULT 0,
  criado_em    TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ── Tabela de histórico de movimentações ─────────────────
CREATE TABLE IF NOT EXISTS historico_movimentacoes (
  id         SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  item_id    INTEGER REFERENCES estoque_items(id) ON DELETE SET NULL,
  item_nome  VARCHAR(200) NOT NULL,
  tipo       VARCHAR(10)  NOT NULL CHECK (tipo IN ('ENTRADA', 'SAÍDA')),
  quantidade INTEGER NOT NULL,
  observacao TEXT,
  criado_em  TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_estoque_usuario   ON estoque_items(usuario_id);
CREATE INDEX IF NOT EXISTS idx_historico_usuario ON historico_movimentacoes(usuario_id);
