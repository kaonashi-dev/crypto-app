# Crypto payment gateway (MVP)

Pasarela de pagos cripto: cobros denominados en **COP**, pagaderos en **USDC** sobre
redes EVM de **testnet** (Ethereum Sepolia y Base Sepolia), con dirección única por
pago, detección on-chain vía WebSocket de Alchemy, manejo de pagos parciales con
ventana de gracia, checkout con QR (EIP-681), webhooks firmados (HMAC) y acreditación
de balance en COP.

**Stack:** Bun + TypeScript + Hono + Drizzle ORM + PostgreSQL + viem + Alchemy.

> Solo testnet. La mnemonic vive en `.env` únicamente para desarrollo. En producción
> se deriva desde **xpub** (sin llaves privadas en el servidor) y el sweep se hace
> desde un entorno frío.

## Cómo funciona

1. El merchant crea un pago (`POST /api/payments`) autenticado con `X-Api-Key`.
2. Se **congela la cotización** COP→USDC (tasa de mercado + spread, válida 15 min) y se
   deriva una **dirección HD única** para ese pago.
3. El pagador abre `checkout_url` (`/pay/:publicId`): QR EIP-681, dirección copiable,
   countdown y polling cada 3 s.
4. El **watcher** (WS de Alchemy, filtrado por `to` indexado) detecta el `Transfer`; el
   **confirmer** espera confirmaciones (5 en Sepolia, 3 en Base Sepolia) con verificación
   anti-reorg; al completar el monto (con tolerancia de dust del 0.5 %) el pago pasa a
   `paid`, se acredita el balance en COP y se encola el webhook `payment.paid`.
5. **Pagos parciales:** el primer depósito abre una ventana de gracia de 90 min para
   completar el monto **a la tasa congelada**. Si vence sin completarse → `underpaid_expired`.

Máquina de estados: `pending → detecting → partially_paid → paid`, con ramas
`expired` (cotización vencida sin fondos) y `underpaid_expired` (gracia vencida).

## Requisitos

- Bun ≥ 1.1
- PostgreSQL 15+
- Cuenta Alchemy con una app en **Ethereum Sepolia** y otra en **Base Sepolia**
- Una mnemonic **nueva** de testnet

## Puesta en marcha

```bash
bun install
cp .env.example .env          # completa ALCHEMY_* y HD_MNEMONIC

# Postgres rápido con Docker (opcional):
docker run -d --name gateway-pg -e POSTGRES_PASSWORD=gateway \
  -e POSTGRES_DB=gateway -p 5432:5432 postgres:16

bun run db:generate           # (ya versionado en drizzle/) genera SQL de migración
bun run db:migrate            # aplica contra Postgres
bun run seed                  # crea un cliente demo y muestra su API KEY (una sola vez)

bun run dev                   # API + watchers + workers (hot reload)
```

Crear un pago:

```bash
curl -s -X POST http://localhost:3000/api/payments \
  -H "X-Api-Key: gk_test_..." -H "Content-Type: application/json" \
  -d '{"amount_cop": 50000, "asset": "USDC", "network": "base-sepolia",
       "metadata": {"order_id": "ORD-001"}}'
# -> responde checkout_url: http://localhost:3000/pay/xxxxx
```

**USDC de prueba:** `faucet.circle.com` (elige la red). Necesitas también ETH de testnet
para el gas. Verifica las direcciones de token de testnet en la doc de Circle antes de usar.

## API

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `POST` | `/api/payments` | `X-Api-Key` | Crea un pago (cotiza + dirección + `checkout_url`) |
| `GET` | `/api/payments/:publicId` | `X-Api-Key` | Estado del pago |
| `GET` | `/api/me` | `X-Api-Key` | Nombre + `balance_cop` acreditado |
| `GET` | `/public/payments/:publicId` | — | Estado público (para la UI, sin datos del merchant) |
| `GET` | `/pay/:publicId` | — | Página de checkout (QR + polling) |
| `GET` | `/health` | — | Liveness |

Montos siempre en la **unidad mínima** (`bigint`, serializado como string): COP sin
decimales, cripto en unidades raw del token (USDC = 6 decimales). Nunca floats para dinero.

## Webhooks

Eventos `payment.paid`, `payment.partially_paid`, `payment.expired`,
`payment.underpaid_expired`. Se firman con **HMAC-SHA256** sobre el body; el merchant
valida la cabecera `X-Gateway-Signature` con su `webhook_secret`. Reintentos con backoff
exponencial (hasta 8 intentos). Pon una URL de webhook en el cliente (p. ej. de
`webhook.site`) para verlos.

Verificación en el merchant (ejemplo):

```ts
const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-gateway-signature"]));
```

## Pruebas

Con un Postgres migrado y `DATABASE_URL` apuntándolo:

```bash
bun run scripts/smoke-test.ts   # máquina de estados: parcial, completo, sobrepago, dust, idempotencia
bun run scripts/api-test.ts     # capa HTTP: routing, auth, QR/EIP-681, endpoint público
bun run typecheck               # tsc --noEmit
```

Ninguno de los dos toca CoinGecko ni la cadena: inyectan depósitos por las mismas
funciones de servicio que usan los workers.

## Estructura

```
src/
  config.ts            env + registro de redes/tokens
  db/                  schema drizzle + conexión
  services/
    rates.ts           CoinGecko + spread + cache 60s + copToRaw (redondeo hacia arriba)
    wallet.ts          derivación HD (índice global reservado atómicamente)
    payments.ts        máquina de estados (crear / registrar depósito / confirmar / expirar)
    webhooks.ts        firma HMAC + cola de reintentos
  workers/
    watcher.ts         WS Alchemy → eventos Transfer (+ backfill por getLogs)
    confirmer.ts       avanza confirmaciones, verifica anti-reorg, liquida
    expirer.ts         expira cotizaciones/gracias + entrega webhooks
  api/                 auth (X-Api-Key) + rutas Hono
  ui/pay.ts            checkout HTML (QR + polling)
scripts/
  seed.ts              crea cliente demo con API key
  smoke-test.ts        test de la máquina de estados contra Postgres real
  api-test.ts          test de la capa HTTP
drizzle/               migraciones SQL versionadas
```

## Notas de entorno

- El proceso corre **todo junto** para el MVP (API + watcher + workers con `setInterval`).
  En producción se separan watcher y API y se usa una cola real (p. ej. pg-boss).
- El watcher/confirmer y CoinGecko requieren salida a `*.alchemy.com` y
  `api.coingecko.com`; en entornos con allowlist de red hay que habilitarlos.

## Robustez incluida

Idempotencia de depósitos por `(network, txHash, logIndex)`; locks `FOR UPDATE` en toda
transición de estado; verificación anti-reorg antes de confirmar; backfill por `getLogs`
para cubrir caídas del WS; redondeo hacia arriba en COP→cripto; tolerancia de dust;
guardia contra doble-acreditación cuando un depósito confirma después de liquidar;
webhooks firmados con reintentos; y ledger de auditoría del balance.

## Pendiente para producción (fase 2/3)

Derivación por xpub + sweep en frío; separar workers de la API con cola real; múltiples
fuentes de precio con mediana; rate limiting y rotación de api keys; BTC vía BTCPay
Server; USDT TRC-20 vía TronGrid; panel admin para resolver `underpaid_expired`; y la
evaluación legal PSAV/DIAN antes de recibir fondos reales en Colombia.
