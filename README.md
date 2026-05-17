# Маркетплейс аренды GPU

В этом репозитории содержатся смарт-контракты для аренды GPU с оплатой токенами GPURENT, использованием эскроу (безопасных платежей) и стейкингом репутации провайдеров.

Быстрый старт:

1. Установите зависимости:

```bash
npm install
```

2. Запустите тесты:

```bash
npx hardhat test
```

3. Развертывание (пример для polygonAmoy):

```bash
npx hardhat run scripts/deploy.js --network polygonAmoy
```

Переменные окружения: скопируйте `.env.example` в `.env` и настройте ключи.

## Локальная интеграция с API

Запустите локальную сеть и экспортируйте метаданные контрактов для `little-blockchain-api`:

```bash
npx hardhat node
npx hardhat run scripts/deploy.js --network localhost
```

Скрипт развертывания записывает адреса в `local-chain/deployed-addresses.json` и файлы ABI в `local-chain/abi/`. Он также выдает `PROVIDER_ROLE` второму аккаунту Hardhat и переводит GPURENT на аккаунты провайдера и клиента.
