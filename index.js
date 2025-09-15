const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config({ path: './config.env' });

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.text());
app.use(express.urlencoded({ extended: true }));

// Database connection
const dbConfig = {
  host: process.env.DB_HOST || '188.166.232.67',
  user: process.env.DB_USER || 'samurai',
  password: process.env.DB_PASSWORD || 'Niloy@Niil9',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'gp_warehouse',
  ssl: {
    rejectUnauthorized: false
  },
  // Vercel serverless optimizations
  max: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

// Debug environment variables (remove in production)
console.log('Database Config:', {
  host: dbConfig.host,
  user: dbConfig.user,
  port: dbConfig.port,
  database: dbConfig.database,
  hasPassword: !!dbConfig.password
});

const pool = new Pool(dbConfig);

// Test database connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Database connection error:', err);
});

// RFID Tag Routes

// GET /api/rfid - Get all RFID tags
app.get('/api/rfid', async (req, res) => {
  try {
    const { status, limit = 100, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM rfid_tags';
    const params = [];
    
    if (status) {
      query += ' WHERE status = $1';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching RFID tags:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching RFID tags',
      error: error.message
    });
  }
});

// GET /api/rfid/:tag_uid - Get specific RFID tag by EPC (param kept for compatibility)
app.get('/api/rfid/:tag_uid', async (req, res) => {
  try {
    const { tag_uid } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM rfid_tags WHERE epc = $1',
      [tag_uid]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'RFID tag not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching RFID tag:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching RFID tag',
      error: error.message
    });
  }
});

// POST /api/rfid - Create new RFID tag (accepts single or array), maps to EPC-based schema
// POST /api/v1/uhf/tags - Create single UHF tag (matches RFID service structure)
app.post('/api/v1/uhf/tags', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { epc, rssi, count, timestamp, deviceId } = req.body;

    // Validation
    if (!epc) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'EPC is required',
        code: 400
      });
    }

    // Check if RFID tag already exists
    const checkQuery = `SELECT id, epc, status FROM rfid_tags WHERE epc = $1;`;
    const existingTag = await client.query(checkQuery, [epc]);

    if (existingTag.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `RFID tag with EPC '${epc}' already exists with status '${existingTag.rows[0].status}'`,
        code: 409
      });
    }

    const insertQuery = `
      INSERT INTO rfid_tags (epc, rssi, count, timestamp, device_id, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;

    const values = [
      epc,
      rssi || null,
      count || 1,
      timestamp ? new Date(timestamp) : new Date(),
      deviceId || null,
      'Available'
    ];

    const result = await client.query(insertQuery, values);
    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: `UHF tag with EPC '${epc}' created successfully`,
      data: JSON.stringify(result.rows[0]),
      code: 201
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('UHF tag creation error:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error occurred',
      code: 500
    });
  } finally {
    client.release();
  }
});

// POST /api/v1/uhf/tags/batch - Create multiple UHF tags (matches RFID service structure)
app.post('/api/v1/uhf/tags/batch', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { tags, sessionId } = req.body;

    if (!Array.isArray(tags) || tags.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'tags array is required and must not be empty',
        code: 400
      });
    }

    const created = [];
    const duplicates = [];
    const errors = [];

    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      try {
        // Check if RFID tag already exists
        const checkQuery = `SELECT id, epc, status FROM rfid_tags WHERE epc = $1;`;
        const existingTag = await client.query(checkQuery, [tag.epc]);

        if (existingTag.rows.length > 0) {
          duplicates.push(tag.epc);
          continue;
        }

        const insertQuery = `
          INSERT INTO rfid_tags (epc, rssi, count, timestamp, device_id, session_id, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *;
        `;

        const values = [
          tag.epc,
          tag.rssi || null,
          tag.count || 1,
          tag.timestamp ? new Date(tag.timestamp) : new Date(),
          tag.deviceId || null,
          sessionId || null,
          'Available'
        ];

        const result = await client.query(insertQuery, values);
        created.push(result.rows[0]);
      } catch (error) {
        errors.push({
          index: i,
          epc: tag.epc,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    await client.query('COMMIT');

    const message = `Batch processed: ${created.length} created, ${duplicates.length} duplicates, ${errors.length} errors`;
    
    res.status(201).json({
      success: true,
      message,
      data: JSON.stringify({
        created,
        duplicates,
        errors,
        summary: {
          total: tags.length,
          created: created.length,
          duplicates: duplicates.length,
          errors: errors.length
        }
      }),
      code: 201
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('UHF tags batch creation error:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error occurred',
      code: 500
    });
  } finally {
    client.release();
  }
});

// GET /api/v1/uhf/tags - Get UHF tags with pagination (matches RFID service structure)
app.get('/api/v1/uhf/tags', async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    
    const query = `
      SELECT * FROM rfid_tags 
      ORDER BY created_at DESC 
      LIMIT $1 OFFSET $2;
    `;
    
    const result = await pool.query(query, [parseInt(limit), parseInt(offset)]);
    
    const countQuery = `SELECT COUNT(*) FROM rfid_tags;`;
    const countResult = await pool.query(countQuery);
    const total = parseInt(countResult.rows[0].count, 10);

    res.status(200).json({
      success: true,
      message: `Retrieved ${result.rows.length} UHF tags`,
      data: JSON.stringify({
        tags: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit)
        }
      }),
      code: 200
    });
  } catch (error) {
    console.error('Error fetching UHF tags:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error occurred',
      code: 500
    });
  }
});

// DELETE /api/v1/uhf/tags/:epc - Delete UHF tag by EPC (matches RFID service structure)
app.delete('/api/v1/uhf/tags/:epc', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { epc } = req.params;

    // Check if RFID tag exists
    const checkQuery = `SELECT id FROM rfid_tags WHERE epc = $1;`;
    const checkResult = await client.query(checkQuery, [epc]);

    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: `RFID tag with EPC '${epc}' not found`,
        code: 404
      });
    }

    const deleteQuery = `DELETE FROM rfid_tags WHERE epc = $1;`;
    await client.query(deleteQuery, [epc]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: `UHF tag with EPC '${epc}' deleted successfully`,
      code: 200
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting UHF tag:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error occurred',
      code: 500
    });
  } finally {
    client.release();
  }
});

// PUT /api/rfid/:tag_uid - Update RFID tag (uses EPC column)
app.put('/api/rfid/:tag_uid', async (req, res) => {
  try {
    const { tag_uid } = req.params;
    const { status, location, reader_id, rssi, count, device_id } = req.body;
    
    // Check if at least one field is provided for update
    if (!status && location === undefined && reader_id === undefined && rssi === undefined && count === undefined && device_id === undefined) {
      return res.status(400).json({
        success: false,
        message: 'At least one field (status, location, reader_id, rssi, count, device_id) is required for update'
      });
    }
    
    // Validate status if provided
    if (status && !['Available', 'Reserved', 'Assigned', 'Consumed', 'Lost', 'Damaged'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be one of: Available, Reserved, Assigned, Consumed, Lost, Damaged'
      });
    }
    
    // Validate parent_tag_id if provided
    if (parent_tag_id !== null && parent_tag_id !== undefined) {
      const parentExists = await pool.query(
        'SELECT id FROM rfid_tags WHERE id = $1',
        [parent_tag_id]
      );
      if (parentExists.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid parent_tag_id: parent tag does not exist'
        });
      }
    }
    
    // Validate current_location_id if provided
    if (current_location_id !== null && current_location_id !== undefined) {
      const locationExists = await pool.query(
        'SELECT id FROM locations WHERE id = $1',
        [current_location_id]
      );
      if (locationExists.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid current_location_id: location does not exist'
        });
      }
    }
    
    // Build dynamic update query
    const updateFields = [];
    const values = [];
    let paramCount = 1;
    
    if (status) {
      updateFields.push(`status = $${paramCount}`);
      values.push(status);
      paramCount++;
    }
    if (location !== undefined) { updateFields.push(`location = $${paramCount}`); values.push(location); paramCount++; }
    if (reader_id !== undefined) { updateFields.push(`reader_id = $${paramCount}`); values.push(reader_id); paramCount++; }
    if (rssi !== undefined) { updateFields.push(`rssi = $${paramCount}`); values.push(String(rssi)); paramCount++; }
    if (count !== undefined) { updateFields.push(`count = $${paramCount}`); values.push(parseInt(count)); paramCount++; }
    if (device_id !== undefined) { updateFields.push(`device_id = $${paramCount}`); values.push(device_id); paramCount++; }
    
    // Always update the updated_at timestamp
    updateFields.push(`updated_at = NOW()`);
    
    // Add tag_uid parameter
    values.push(tag_uid);
    
    const query = `UPDATE rfid_tags SET ${updateFields.join(', ')} WHERE epc = $${paramCount} RETURNING *`;
    
    const result = await pool.query(query, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'RFID tag not found'
      });
    }
    
    res.json({
      success: true,
      message: 'RFID tag updated successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating RFID tag:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating RFID tag',
      error: error.message
    });
  }
});

// DELETE /api/rfid/tag-id/:tag_uid - Delete RFID tag by EPC (param kept for compatibility)
app.delete('/api/rfid/tag-id/:tag_uid', async (req, res) => {
  try {
    const { tag_uid } = req.params;
    
    const result = await pool.query(
      'DELETE FROM rfid_tags WHERE epc = $1 RETURNING *',
      [tag_uid]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'RFID tag not found'
      });
    }
    
    res.json({
      success: true,
      message: 'RFID tag deleted successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error deleting RFID tag:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting RFID tag',
      error: error.message
    });
  }
});

// DELETE /api/rfid/id/:id - Delete RFID tag by ID
app.delete('/api/rfid/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate that id is a number
    const numericId = parseInt(id);
    if (isNaN(numericId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid ID. Must be a number'
      });
    }
    
    const result = await pool.query(
      'DELETE FROM rfid_tags WHERE id = $1 RETURNING *',
      [numericId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'RFID tag not found'
      });
    }
    
    res.json({
      success: true,
      message: 'RFID tag deleted successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error deleting RFID tag by ID:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting RFID tag',
      error: error.message
    });
  }
});

// POST /api/rfid/bulk - Create multiple RFID tags (EPC-based schema)
app.post('/api/rfid/bulk', async (req, res) => {
  try {
    const { tags } = req.body;
    
    if (!Array.isArray(tags) || tags.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'tags array is required and must not be empty'
      });
    }
    
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const results = [];
      const errors = [];
      
      for (let i = 0; i < tags.length; i++) {
        const raw = tags[i] || {};
        const epc = (raw.epc || raw.tag_uid || raw.uid || raw.tag || '').toString().trim();
        const rssi = raw.rssi !== undefined ? String(raw.rssi) : (raw.signal || raw.rssi_dbm || null);
        const count = raw.count !== undefined ? parseInt(raw.count) : 1;
        const device_id = (raw.deviceId || raw.device_id || raw.reader || raw.reader_id || null);
        const location = raw.location || null;
        const reader_id = raw.reader_id || null;
        const status = (raw.status || 'Available');
        let timestamp = new Date();
        if (raw.timestamp !== undefined) {
          const t = Number(raw.timestamp);
          timestamp = isNaN(t) ? new Date(raw.timestamp) : new Date(t);
        } else if (raw.ts !== undefined) {
          const t = Number(raw.ts);
          timestamp = isNaN(t) ? new Date(raw.ts) : new Date(t);
        }

        if (!epc) {
          errors.push({ index: i, error: 'EPC is required' });
          continue;
        }
        const allowed = ['Available', 'Reserved', 'Assigned', 'Consumed', 'Lost', 'Damaged'];
        if (!allowed.includes(status)) {
          errors.push({ index: i, error: `Invalid status. Must be one of: ${allowed.join(', ')}` });
          continue;
        }
        
        // Validate parent_tag_id if provided
        if (parent_tag_id !== null && parent_tag_id !== undefined) {
          // parent_tag_id no longer used in EPC schema; ignore gracefully
        }
        
        // Validate current_location_id if provided
        if (current_location_id !== null && current_location_id !== undefined) {
          // current_location_id no longer used in EPC schema; ignore gracefully
        }
        
        try {
          // Duplicate check
          const existing = await client.query('SELECT id FROM rfid_tags WHERE epc = $1', [epc]);
          if (existing.rows.length > 0) {
            errors.push({ index: i, error: 'RFID tag with this EPC already exists' });
            continue;
          }
          const result = await client.query(
            `INSERT INTO rfid_tags (epc, timestamp, location, reader_id, status, rssi, count, device_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [epc, timestamp, location, reader_id, status, rssi, isNaN(count) ? 1 : count, device_id]
          );
          results.push(result.rows[0]);
        } catch (error) {
          errors.push({ index: i, error: error.message });
        }
      }
      
      await client.query('COMMIT');
      
      res.status(201).json({
        success: true,
        message: `Created ${results.length} RFID tags`,
        data: results,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating bulk RFID tags:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating bulk RFID tags',
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      success: true,
      message: 'Database connection is healthy',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Database connection failed',
      error: error.message
    });
  }
});

// Debug endpoint to check environment variables
app.get('/debug', (req, res) => {
  res.json({
    success: true,
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      DB_HOST: process.env.DB_HOST || 'NOT_SET',
      DB_USER: process.env.DB_USER || 'NOT_SET',
      DB_PORT: process.env.DB_PORT || 'NOT_SET',
      DB_NAME: process.env.DB_NAME || 'NOT_SET',
      hasPassword: !!process.env.DB_PASSWORD
    },
    dbConfig: {
      host: dbConfig.host,
      user: dbConfig.user,
      port: dbConfig.port,
      database: dbConfig.database
    }
  });
});

// Debug endpoint to test data reception
app.post('/debug/data', (req, res) => {
  res.json({
    success: true,
    receivedData: {
      body: req.body,
      bodyType: typeof req.body,
      headers: req.headers,
      contentType: req.get('Content-Type')
    }
  });
});

// Test database connection endpoint
app.get('/test-db', async (req, res) => {
  try {
    console.log('Testing database connection...');
    const result = await pool.query('SELECT NOW() as current_time, version() as db_version');
    res.json({
      success: true,
      message: 'Database connection successful',
      data: result.rows[0],
      dbConfig: {
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database
      }
    });
  } catch (error) {
    console.error('Database test error:', error);
    res.status(500).json({
      success: false,
      message: 'Database connection failed',
      error: error.message,
      dbConfig: {
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database
      }
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'RFID Tag Management API',
    version: '1.0.0',
    endpoints: {
      'GET /api/rfid': 'Get all RFID tags (with optional status filter)',
      'GET /api/rfid/:tag_uid': 'Get specific RFID tag by UID',
      'POST /api/rfid': 'Create new RFID tag',
      'PUT /api/rfid/:tag_uid': 'Update RFID tag status',
      'DELETE /api/rfid/:tag_uid': 'Delete RFID tag by tag_uid',
      'DELETE /api/rfid/id/:id': 'Delete RFID tag by database ID',
      'POST /api/rfid/bulk': 'Create multiple RFID tags',
      'GET /health': 'Health check'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// Start server (only in development)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`RFID Tag Management API running on port ${PORT}`);
  });
}

// Graceful shutdown (only in development)
if (process.env.NODE_ENV !== 'production') {
  process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await pool.end();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    await pool.end();
    process.exit(0);
  });
}

// Export for Vercel
module.exports = app;
