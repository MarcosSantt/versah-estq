# Versah EstoqueControl 🗃️

Sistema de controle de estoque multi-usuário rodando 100% com Docker.
**Sem Firebase. Sem dependências de nuvem.** PostgreSQL local com dados persistentes.

---

## Estrutura do projeto

```
versah-estoquecontrol/
├── docker-compose.yml          ← Orquestração dos containers
├── backend/
│   ├── Dockerfile              ← Imagem Node.js
│   ├── package.json
│   ├── server.js               ← API REST (Express + JWT + bcrypt)
│   └── init.sql                ← Schema do banco (roda no 1º boot)
└── frontend/
    ├── login.html              ← Tela de login e cadastro
    ├── index.html              ← Tela principal do estoque
    └── admin.html              ← Área do administrador
```

---

## Como subir o sistema

### Pré-requisitos
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado e rodando

### 1. Subir tudo com um comando

```bash
cd versah-estoquecontrol
docker compose up --build
```

Na primeira vez, o Docker irá:
1. Baixar as imagens do PostgreSQL e Node.js
2. Criar o banco de dados com as tabelas automaticamente (via `init.sql`)
3. Instalar as dependências do backend
4. Subir os três containers

### 2. Acessar o sistema

Abra no navegador:
```
http://localhost:8080/login.html
```

Crie uma conta e comece a usar.

### 3. Parar o sistema

```bash
docker compose down
```

> ✅ Os dados **ficam salvos** no volume Docker mesmo após `down`.  
> Para apagar tudo (inclusive dados): `docker compose down -v`

---

## Variáveis de ambiente (produção)

Edite o `docker-compose.yml` antes de subir em produção:

| Variável | Padrão | O que é |
|---|---|---|
| `POSTGRES_PASSWORD` | `versah_secret` | Senha do banco |
| `JWT_SECRET` | `mude_esta_chave...` | Chave de assinatura dos tokens JWT |

**Sempre troque o `JWT_SECRET` em produção.** Use pelo menos 32 caracteres aleatórios:
```bash
openssl rand -base64 32
```

---

## Como funciona a autenticação

1. Usuário se cadastra → senha salva com **bcrypt** (12 rounds)
2. Login bem-sucedido → backend retorna um **JWT** com validade de 7 dias
3. Frontend armazena o token no `localStorage`
4. Todas as requisições ao estoque enviam o token no header `Authorization: Bearer <token>`
5. Backend valida o token e filtra os dados pelo `usuario_id` do token
6. **Usuário A nunca vê dados do Usuário B** — isolamento garantido pelo `WHERE usuario_id = $x` em todas as queries

---

## Área do administrador

Em `admin.html` (link **Administração** no menu lateral, visível só para administradores):

- **Visão geral** — usuários ativos, acessos nos últimos 7 dias, itens cadastrados, itens em alerta e
  movimentações dos últimos 30 dias, somando todos os usuários.
- **Usuários** — criar conta, editar nome/e-mail, marcar como administrador, ativar/desativar,
  redefinir senha e ver o estoque de cada usuário (somente leitura).
- **Configurações** — ligar/desligar o cadastro livre na tela de login.

Ao criar uma conta ou redefinir a senha, o sistema gera uma **senha provisória** exibida uma única vez;
no primeiro acesso a pessoa é obrigada a definir a própria senha. Desativar um usuário ou redefinir a
senha encerra as sessões abertas dele na hora.

### Primeiro administrador

Defina a variável `ADMIN_EMAIL` no backend (Render ou `docker-compose.yml`) com o e-mail de uma conta
já cadastrada e reinicie: ela vira administradora automaticamente. Depois disso, outros administradores
podem ser marcados pela própria tela. As colunas e tabelas novas são criadas sozinhas ao subir o backend.

## Endpoints da API

```
POST   /api/auth/cadastro        Cria conta
POST   /api/auth/login           Autentica (retorna JWT)
GET    /api/auth/me              Dados do usuário logado

GET    /api/estoque              Lista itens do usuário
POST   /api/estoque              Cria item
PUT    /api/estoque/:id          Edita item
DELETE /api/estoque/:id          Remove item
POST   /api/estoque/:id/mover    Entrada ou saída de estoque

GET    /api/historico            Últimas 50 movimentações
POST   /api/auth/trocar-senha    Troca a própria senha
GET    /api/config               Configurações públicas (autocadastro)

GET    /api/admin/resumo                       Números gerais (admin)
GET    /api/admin/usuarios                     Lista usuários com indicadores
POST   /api/admin/usuarios                     Cria usuário com senha provisória
PUT    /api/admin/usuarios/:id                 Edita nome, e-mail, perfil e status
POST   /api/admin/usuarios/:id/redefinir-senha Gera nova senha provisória
GET    /api/admin/usuarios/:id/estoque         Estoque do usuário (leitura)
GET    /api/admin/configuracoes                Configurações
PUT    /api/admin/configuracoes                Salva configurações
GET    /health                   Healthcheck
```

---

## Acessar o banco de dados diretamente (opcional)

Com o sistema rodando, você pode acessar o PostgreSQL pelo DBeaver, TablePlus ou qualquer cliente:

- **Host:** `localhost`
- **Porta:** `5432`
- **Banco:** `versah_estoque`
- **Usuário:** `versah_user`
- **Senha:** `versah_secret`
