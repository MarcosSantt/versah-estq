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
  atual        DECIMAL(10,3) NOT NULL DEFAULT 0,
  minimo       DECIMAL(10,3) NOT NULL DEFAULT 0,
  ideal        DECIMAL(10,3) NOT NULL DEFAULT 0,
  categoria    VARCHAR(100) NOT NULL DEFAULT 'Sem categoria',
  unidade      VARCHAR(50)  NOT NULL DEFAULT 'un',
  criado_em    TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Fallback para bancos já existentes em versões anteriores
ALTER TABLE estoque_items
  ADD COLUMN IF NOT EXISTS categoria VARCHAR(100) DEFAULT 'Sem categoria',
  ADD COLUMN IF NOT EXISTS unidade VARCHAR(50) DEFAULT 'un';

ALTER TABLE estoque_items
  ALTER COLUMN atual TYPE DECIMAL(10,3) USING atual::DECIMAL(10,3),
  ALTER COLUMN minimo TYPE DECIMAL(10,3) USING minimo::DECIMAL(10,3),
  ALTER COLUMN ideal TYPE DECIMAL(10,3) USING ideal::DECIMAL(10,3);

-- ── Tabela de histórico de movimentaçõess ─────────────────
CREATE TABLE IF NOT EXISTS historico_movimentacoes (
  id            SERIAL PRIMARY KEY,
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  item_id       INTEGER REFERENCES estoque_items(id) ON DELETE SET NULL,
  item_nome     VARCHAR(200) NOT NULL,
  tipo          VARCHAR(10)  NOT NULL CHECK (tipo IN ('ENTRADA', 'SAÍDA')),
  quantidade    DECIMAL(10,3) NOT NULL,
  observacao    TEXT,
  lote          VARCHAR(100),
  data_validade DATE,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE historico_movimentacoes
  ADD COLUMN IF NOT EXISTS lote VARCHAR(100),
  ADD COLUMN IF NOT EXISTS data_validade DATE,
  ALTER COLUMN quantidade TYPE DECIMAL(10,3) USING quantidade::DECIMAL(10,3);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_estoque_usuario   ON estoque_items(usuario_id);
CREATE INDEX IF NOT EXISTS idx_historico_usuario ON historico_movimentacoes(usuario_id);
