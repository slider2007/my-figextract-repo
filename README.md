# FigExtract — Debian 12 VPS distribution

FigExtract — это веб-инструмент для извлечения изображений из Figma-проекта по публичной ссылке и Figma API token. В дистрибутив входят фронтенд, Node.js backend-прокси, unit-файл для systemd и конфиг для Nginx. Figma поддерживает аутентификацию через personal access token для REST API. [web:58][web:61][web:62]

## Состав дистрибутива

- `app/` — Node.js приложение и статический веб-интерфейс.
- `deploy/figextract.service` — unit-файл systemd для автозапуска сервиса.
- `deploy/nginx-figextract.conf` — конфиг reverse proxy для Nginx.
- `scripts/install.sh` — автоматическая установка на Debian 12.

## Требования

- Debian 12.
- Домен или IP VPS.
- Root-доступ или пользователь с `sudo`.
- Figma personal access token для выполнения REST API запросов. [web:58][web:61]

## Быстрый старт

1. Скопируйте дистрибутив на сервер, например в `/root/figextract-dist`.
2. Запустите установщик:

```bash
cd /root/figextract-dist
sudo bash scripts/install.sh
```

Скрипт устанавливает `nginx`, `nodejs`, `npm`, создаёт системного пользователя `figextract`, размещает приложение в `/opt/figextract`, устанавливает зависимости, активирует unit `figextract.service` и включает сайт в Nginx. Для Debian-подобных систем стандартный путь установки Nginx и схема с `sites-available`/`sites-enabled` широко используются в типовых инструкциях. [web:65][web:81][web:82]

## Управление сервисом

```bash
sudo systemctl status figextract
sudo systemctl restart figextract
sudo journalctl -u figextract -n 100 --no-pager
```

systemd подходит для постоянного запуска Node.js-приложений на сервере и позволяет автоматически поднимать сервис после перезагрузки. [web:82]

## Nginx

Приложение слушает `127.0.0.1:3017`, а Nginx принимает внешний HTTP-трафик на 80 порту и проксирует его на локальный backend. Такая схема типична для production-развёртывания Node.js на Debian/Ubuntu. [web:65][web:81]

Если нужен домен, замените строку `server_name _;` в `deploy/nginx-figextract.conf` на ваш домен и перезапустите Nginx:

```bash
sudo nginx -t
sudo systemctl restart nginx
```

## HTTPS

Для production рекомендуется поставить TLS-сертификат, например через Let's Encrypt, и настроить редирект с 80 на 443 на стороне Nginx. Использование Nginx как reverse proxy перед Node.js — стандартный подход для SSL-терминации. [web:65][web:81]

## Безопасность

- В этой сборке token отправляется с браузера на ваш собственный сервер FigExtract, а уже сервер выполняет запросы к Figma API. Это снижает риск прямого раскрытия токена в клиентских запросах к `api.figma.com`.
- Personal access token даёт доступ от имени пользователя, который его создал, поэтому хранить и передавать его нужно аккуратно. [web:62]
- Желательно ограничить доступ к самому приложению через базовую HTTP-аутентификацию в Nginx или VPN, если инструмент предназначен только для внутреннего использования.

## Как работает извлечение

Приложение получает структуру файла через endpoint `files`, затем батчами запрашивает экспортные URL изображений через endpoint `images`. Это соответствует модели Figma REST API для доступа к JSON-представлению файла и изображений отдельных нод. [web:32][web:59]
