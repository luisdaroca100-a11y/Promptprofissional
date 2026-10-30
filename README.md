# Assistente Financeiro — Robô Financeiro

Site assistente de **finanças pessoais** em formato de **conversa**: o
usuário conta seus gastos, ganhos, faturas de cartão, contas e dívidas, o
Robô Financeiro **registra tudo** no banco, lembra da conversa **inteira**
e mostra o **resumo do mês** (ganhos, gastos, faturas de cartão, dívidas
em aberto e saldo) num painel, com lista de registros e botão de excluir.

O robô organiza e calcula — não promete rentabilidade nem dá
recomendação de investimento personalizada; explica conceitos e simula
cenários de forma educativa.

Modelo de negócio (v1): assinatura com pagamento avulso por período via **Pix
(Mercado Pago)** — sem débito automático.
- **Teste:** R$ 1,99 = 1 dia de acesso (só pode ser usado uma vez por conta).
- **Mensal:** R$ 19,90 = 30 dias de acesso (o botão de renovar paga de novo e
  estende 30 dias a partir do vencimento atual).

Repositório: **https://github.com/luisdaroca100-a11y/Promptprofissional**

Arquitetura: frontend estático (`index.html` + `app.js` + `styles.css`, sem
build) + funções serverless Node na Vercel (`api/`). O navegador fala SOMENTE
com `/api/*` e com o Supabase Auth — a chave da IA e o token do Mercado
Pago ficam **só no servidor**, lidos de variáveis de ambiente. Nenhuma chave
está no código.

## Estrutura

```
index.html                 Frontend: página pública, login, chat, resumo do mês, planos/Pix
styles.css                 Tema escuro profissional, acento dourado
app.js                     Lógica do chat, conversas, resumo do mês, pagamento Pix
api/_lib.js                Helpers (Supabase REST, auth, acesso)
api/config.js              Config pública (URL + anon key do Supabase)
api/me.js                  Usuário atual + status de acesso
api/chat.js                Proxy de IA — Groq (se GROQ_API_KEY existir) com fallback pro Gemini; memória total da conversa; extrai blocos ---REGISTRO---, ---CARTAO--- e ---PARCELA--- e salva em finance_entries, cards e installments
api/finance.js             Resumo do mês (GET: entradas, cartões, parcelas) + excluir registro/cartão/parcela (DELETE)
api/mp-create-payment.js   Cria Pix + verifica pagamento já feito
api/mp-webhook.js          Webhook do Mercado Pago (libera acesso)
supabase.sql               Schema completo (tabelas + RLS + trigger)
README.md                  Este arquivo
```

## 1. Banco de dados (Supabase)

O projeto Supabase já existe. Rode o arquivo `supabase.sql` inteiro no
**SQL Editor** do projeto (Dashboard > SQL Editor > New query > colar > Run).

Ele cria: `profiles`, `user_access`, `usage` (sem uso — o limite diário
foi removido), `conversations`, `messages`, `processed_payments`,
`finance_entries`, `cards` e `installments`, com RLS ativado (cada
usuário só vê os próprios dados) e um trigger que cria o perfil ao
cadastrar.

> Quem **já rodou** o `supabase.sql` antes precisa rodar **só os trechos
> finais** marcados `NOVO (Assistente Financeiro)` (cria apenas a tabela
> `finance_entries`) e `NOVO v2` (cria `cards` e `installments` e a
> coluna `recorrente` em `finance_entries`). Sem as tabelas novas, o chat
> avisa que não conseguiu salvar os registros (nada se perde em
> silêncio) e o painel de resumo mostra o aviso de SQL pendente. O
> trecho `MIGRAÇÃO` (contador de mensagens) **não precisa mais ser
> rodado**: o limite diário foi removido e a tabela `usage` ficou sem uso.

> Em **Authentication > Providers**, deixe o provedor **Email** ativado.
> Em **Authentication > URL Configuration**, ajuste o **Site URL** para o
> domínio final do site na Vercel (ex.: `https://promptprofissional7gg6.vercel.app`).

### Tabela finance_entries

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | uuid PK | gerado automaticamente |
| `user_id` | uuid | dono do registro (`auth.users`) |
| `tipo` | text | `gasto`, `ganho`, `fatura`, `conta` ou `divida` |
| `descricao` | text | ex.: "Mercado", "Fatura Nubank" |
| `valor` | numeric(12,2) | valor em R$ |
| `categoria` | text | ex.: mercado, moradia, cartão |
| `data` | date | data do gasto/ganho |
| `cartao` | text/null | nome do cartão (fatura/gasto no cartão) |
| `vencimento` | date/null | vencimento (fatura/conta/dívida) |
| `pago` | boolean | padrão `false` |
| `recorrente` | boolean | `true` = repete todo mês (salário, aluguel); padrão `false` |
| `created_at` | timestamptz | criação do registro |

### Tabela cards (cartões com limites)

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | uuid PK | gerado automaticamente |
| `user_id` | uuid | dono do cartão (`auth.users`) |
| `nome` | text | nome do cartão (único por usuário) |
| `limite` | numeric(12,2) | limite do cartão em R$ |
| `dia_fechamento` | int/null | dia do fechamento (1–31) |
| `dia_vencimento` | int/null | dia do vencimento (1–31) |
| `created_at` | timestamptz | criação do registro |

### Tabela installments (compras parceladas)

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | uuid PK | gerado automaticamente |
| `user_id` | uuid | dono da compra (`auth.users`) |
| `descricao` | text | ex.: "Geladeira" |
| `valor_total` | numeric(12,2) | valor cheio da compra |
| `num_parcelas` | int | quantidade de parcelas |
| `valor_parcela` | numeric(12,2) | valor de cada parcela |
| `data_inicio` | date | data da primeira parcela |
| `cartao` | text/null | nome do cartão, se for no cartão |
| `categoria` | text | ex.: eletrodomésticos |
| `created_at` | timestamptz | criação do registro |

O resumo do mês soma: **ganhos** (`ganho`, incluindo recorrentes),
**gastos** (`gasto` + `conta`, incluindo recorrentes, + parcelas do mês),
**faturas** (`fatura`, separadas para não contar duas vezes) e **dívidas em
aberto** (`divida` não paga, fora do saldo). Saldo = ganhos − gastos − faturas.
Parcelas do mês: a compra aparece uma vez por mês, da data de início até
completar `num_parcelas` (parcela k/N). Usado do cartão = faturas com
aquele cartão + parcelas do mês naquele cartão; disponível = limite − usado.

## 2. IA — Groq (teste gratuito) ou Gemini (Google AI Studio)

Se a variável `GROQ_API_KEY` estiver configurada, o chat usa a **Groq**
( endpoint compatível com a API da OpenAI, modelo padrão
`openai/gpt-oss-120b`, trocável por `GROQ_MODEL`) e só cai para o Gemini
se a Groq falhar. Sem a chave da Groq, o chat usa só o Gemini, como antes.

1. Abra https://console.groq.com (crie a conta com e-mail, Google ou GitHub).
2. Em **API Keys**, clique em **Create API Key** e copie a chave.
   O plano gratuito não pede cartão.
3. Ela será colada como variável de ambiente na Vercel (passo 4) — **nunca**
   cole a chave no código, no chat ou no repositório.

O Gemini continua como alternativa/fallback: a chave sai do
https://aistudio.google.com/apikey (modelo usado: `gemini-3.8-flash`).
A cota gratuita do Gemini é compartilhada entre todos os usuários do site;
se o volume crescer, ative o faturamento (billing) no Google Cloud do
projeto da chave — o código não muda.

### Como o registro funciona

Quando o usuário relata um gasto, ganho, fatura, conta ou dívida, a IA
emite um bloco `---REGISTRO--- {json} ---END---` no fim da resposta;
limite de cartão vira `---CARTAO--- {json} ---END---` (upsert por nome)
e compra parcelada vira `---PARCELA--- {json} ---END---`. O servidor
(`api/chat.js`) extrai os blocos, valida os campos, insere nas tabelas
via service-role key, **remove os blocos JSON da resposta visível** e
confirma numa frase curta o que foi salvo. Se a inserção falhar, a
resposta diz claramente que não conseguiu salvar e que falta rodar o
SQL novo — o dado aparece na mensagem para não se perder. Regra
anti-duplicidade: compra parcelada vira SÓ parcela, nunca um registro
avulso de gasto/fatura para a mesma compra.

## 3. Mercado Pago (Pix)

1. Crie uma conta/“aplicação” no [Mercado Pago Developers](https://www.mercadopago.com.br/developers).
2. Copie o **Access Token de produção** (começa com `APP_USR-`).
   Use o token de **produção**, não o de teste, para cobrar de verdade.
3. O código já envia `notification_url` apontando para o webhook do próprio
   domínio ao criar cada pagamento. Mesmo assim, confira no painel do
   Mercado Pago se o webhook está ativo; a URL final é:

   ```
   https://SEU-DOMINIO.vercel.app/api/mp-webhook
   ```

   Substitua `SEU-DOMINIO` pelo domínio real após o deploy.
4. O token será colado como variável de ambiente na Vercel (passo 4).

## 4. Deploy na Vercel (importar o repositório)

1. Abra https://vercel.com/new e escolha **Import Git Repository**.
2. Selecione o repositório **luisdaroca100-a11y/Promptprofissional**.
3. Framework Preset: **Other** (não há build — é HTML + funções `api/`).
4. Antes de clicar em **Deploy**, abra **Environment Variables** e adicione
   exatamente estas variáveis (valores colados por você, nunca no código):

   | Variável | Onde achar |
   |---|---|
   | `SUPABASE_URL` | Supabase > Settings > API > Project URL |
   | `SUPABASE_ANON_KEY` | Supabase > Settings > API > anon public |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase > Settings > API > service_role (segredo — só no servidor) |
   | `GEMINI_API_KEY` | Google AI Studio (passo 2) — fallback |
   | `GROQ_API_KEY` | Console da Groq (passo 2) — provedor principal quando configurada |
   | `GROQ_MODEL` | Opcional: outro modelo Groq (padrão `openai/gpt-oss-120b`) |
   | `MP_ACCESS_TOKEN` | Mercado Pago Developers (passo 3) |

5. Clique em **Deploy**. Pronto: o site estará no domínio `.vercel.app`
   (ou no domínio próprio, se configurar um).

> Depois de trocar qualquer variável de ambiente, faça **Redeploy**
> (Deployments > ⋯ > Redeploy) para valer.

## 5. Como testar (fluxo completo)

1. Rode os trechos novos do `supabase.sql` (tabela `finance_entries` +
   trecho `NOVO v2`: `cards`, `installments` e coluna `recorrente`) no
   SQL Editor do Supabase.
2. Abra o site, crie uma conta com e-mail e senha.
3. A tela de planos aparece: pague o **teste de R$ 1,99** com Pix
   (QR Code ou copia e cola) e toque em **“Já paguei, verificar”**.
4. Converse com o Robô Financeiro: diga, por exemplo, "Gastei R$ 120 no
   mercado hoje, registra" — ele confirma o registro e o painel **Resumo
   do mês** mostra o gasto e o saldo atualizados.
5. Diga "Minha fatura do cartão fechou em R$ 850, vence dia 10" e veja a
   fatura separada no resumo. Use o ✕ para excluir um registro.
6. Feche e reabra o navegador: o histórico da conversa e os registros
   continuam lá (ficam no banco, não só no aparelho).
7. Para renovar, a tela de planos reaparece ao vencer — pague de novo
   e o acesso estende 30 dias.

## Limites e regras (v1)

- **Sem limite de mensagens:** o chat é ilimitado para quem tem acesso
  ativo. Não há contador diário nem bloqueio por uso.
- **Memória:** o backend envia o histórico completo da conversa à IA
  (Groq ou Gemini) a cada turno (limitado às últimas 200 mensagens por conversa).
- **Registro:** só é salvo quando a IA emite o bloco `---REGISTRO---`
  válido; falha de gravação vira aviso claro na resposta, nunca perda
  silenciosa.
- **Teste único:** cada conta só pode comprar o teste de R$ 1,99 uma vez
  (verificado em `processed_payments`).
- **Webhook idempotente:** notificações duplicadas do mesmo `payment_id`
  são ignoradas.
- **Sem débito automático:** cada período é um pagamento Pix avulso.

## Premissas anotadas (API do Mercado Pago)

- Criação de pagamento: `POST https://api.mercadopago.com/v1/payments`
  com `payment_method_id: "pix"`, `transaction_amount`, `description`,
  `payer.email`, `external_reference` (`userId:plano:timestamp`) e
  `notification_url` — forma documentada da API REST do Mercado Pago.
- O QR Code vem em
  `point_of_interaction.transaction_data.qr_code_base64` e o copia e cola
  em `qr_code`, conforme a resposta documentada da API.
- A notificação do webhook traz `type: "payment"` + `data.id`; o servidor
  sempre consulta o pagamento na API antes de liberar o acesso (não confia
  só no corpo da notificação).

## Segurança

- As chaves `service_role`, `GEMINI_API_KEY`, `GROQ_API_KEY` e `MP_ACCESS_TOKEN` só existem
  como variáveis de ambiente no servidor. O frontend recebe, via
  `/api/config`, apenas a URL e a anon key do Supabase (feitas para uso no
  navegador e protegidas pelas políticas RLS).
- Nunca faça commit de arquivos `.env` nem cole chaves no repositório.
