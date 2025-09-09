# RFID Tag Management API

A Node.js Express application for managing RFID tags with PostgreSQL database.

## Features

- Create, read, update, and delete RFID tags
- Bulk creation of RFID tags
- Status management (available, reserved, assigned, consumed, lost, damaged)
- Database connection pooling
- Error handling and validation
- Health check endpoint

## Setup

1. Install dependencies:
```bash
npm install
```

2. The database credentials are already configured in `config.env`

3. Start the server:
```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## API Endpoints

### Base URL: `http://localhost:5000`

#### 1. Get All RFID Tags
```
GET /api/rfid
```
Query parameters:
- `status` (optional): Filter by status
- `limit` (optional): Number of records to return (default: 100)
- `offset` (optional): Number of records to skip (default: 0)

Example:
```
GET /api/rfid?status=available&limit=10&offset=0
```

#### 2. Get Specific RFID Tag
```
GET /api/rfid/:tag_uid
```

Example:
```
GET /api/rfid/ABC123456789
```

#### 3. Create New RFID Tag
```
POST /api/rfid
```
Body:
```json
{
  "tag_uid": "ABC123456789",
  "status": "available"
}
```

#### 4. Update RFID Tag Status
```
PUT /api/rfid/:tag_uid
```
Body:
```json
{
  "status": "assigned"
}
```

#### 5. Delete RFID Tag
```
DELETE /api/rfid/:tag_uid
```

#### 6. Bulk Create RFID Tags
```
POST /api/rfid/bulk
```
Body:
```json
{
  "tags": [
    {
      "tag_uid": "ABC123456789",
      "status": "available"
    },
    {
      "tag_uid": "DEF987654321",
      "status": "available"
    }
  ]
}
```

#### 7. Health Check
```
GET /health
```

## RFID Tag Statuses

- `available`: Tag is available for use
- `reserved`: Tag is reserved for a specific purpose
- `assigned`: Tag is assigned to an item/person
- `consumed`: Tag has been used/consumed
- `lost`: Tag is lost
- `damaged`: Tag is damaged and unusable

## Database Schema

The application uses the following table structure:

```sql
CREATE TABLE rfid_tags (
  id            BIGSERIAL PRIMARY KEY,
  tag_uid       VARCHAR(64) UNIQUE NOT NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'available'
                CHECK (status IN ('available','reserved','assigned','consumed','lost','damaged')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Response Format

All API responses follow this format:

```json
{
  "success": true|false,
  "message": "Description of the operation",
  "data": {}, // or [] for arrays
  "error": "Error message if success is false"
}
```

## Error Handling

The API includes comprehensive error handling for:
- Database connection issues
- Invalid input validation
- Duplicate tag UIDs
- Missing required fields
- Invalid status values

## Environment Variables

The following environment variables are configured in `config.env`:

- `NODE_ENV`: Environment (development/production)
- `PORT`: Server port (default: 5000)
- `DB_HOST`: PostgreSQL host
- `DB_USER`: Database username
- `DB_PASSWORD`: Database password
- `DB_PORT`: Database port
- `DB_NAME`: Database name
