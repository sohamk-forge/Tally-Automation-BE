# Tally Automation Backend

## Overview

Node.js + Express backend that connects with TallyPrime through XML over HTTP, converts XML responses to JSON, and exposes REST APIs for frontend/dashboard usage.

## Tech Stack

* Node.js
* Express.js
* Axios
* fast-xml-parser
* CORS
* TallyPrime / Tally ERP (Port 9000)

## Project Flow

Frontend → Node.js API → XML Request → Tally → XML Response → Node.js → JSON Response → Frontend

## Base URL

```text
http://localhost:5000
```

## Available APIs

### 1. Health Check

```http
GET /api/sync/health
```

Checks whether Tally server is reachable.

### 2. Companies API

```http
GET /api/companies
```

Fetches company list from Tally.

### 3. Ledgers API

```http
GET /api/ledgers?company=Sai%20Computech
```

Fetches ledgers of selected company.

### 4. Products API

```http
GET /api/products?company=Sai%20Computech
```

Fetches stock items / products.

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create `.env`

```env
PORT=5000
TALLY_URL=http://localhost:9000
```

### 3. Start Server

```bash
npm run dev
```

## Tally Requirements

* TallyPrime installed
* Company opened in Tally
* HTTP Server enabled on Port 9000

## Suggested Folder Structure

```text
src/
 ├── api/
 ├── services/
 ├── config/
 ├── app.js
 └── server.js
```

## Postman Collection

Use environment variable:

```text
base_url = http://localhost:5000
```

## Current Status

* Health API ✅
* Companies API ✅
* Ledgers API ✅
* Products API ✅
* Challan API ⏳
* Voucher Sync API ⏳
* PostgreSQL Sync ⏳

## Future Scope

* Store Tally data in PostgreSQL
* Dashboard analytics
* Scheduled sync jobs
* Invoice / Challan automation
* Multi-company support

## Author

Rohan Patil
