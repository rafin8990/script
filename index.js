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

// GET /api/rfid/:tag_uid - Get specific RFID tag by UID
app.get('/api/rfid/:tag_uid', async (req, res) => {
  try {
    const { tag_uid } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM rfid_tags WHERE tag_uid = $1',
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

// POST /api/rfid - Create new RFID tag
app.post('/api/rfid', async (req, res) => {
  try {
    let requestData = req.body;
    
    // Handle raw content from Laravel (when sent as text/plain)
    if (typeof req.body === 'string') {
      try {
        requestData = JSON.parse(req.body);
      } catch (parseError) {
        console.error('JSON parse error:', parseError);
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON format',
          error: parseError.message,
          receivedData: req.body
        });
      }
    }
    
    // Handle both single object and array of objects
    let tagsToProcess = Array.isArray(requestData) ? requestData : [requestData];
    console.log('Tags to process:', tagsToProcess);
    
    const results = [];
    const errors = [];
    
    for (let i = 0; i < tagsToProcess.length; i++) {
      const tagData = tagsToProcess[i];
      const { 
        form_data, 
        status = 'available', 
        parent_tag_id = null, 
        current_location_id = null 
      } = tagData;
      
      // Extract tag_uid from various possible data structures
      let tag_uid;
      
      // Check if form_data exists
      if (form_data !== undefined) {
        try {
          if (typeof form_data === 'string') {
            // Parse the string array format "[1,assfdf]"
            const parsedArray = JSON.parse(form_data);
            if (Array.isArray(parsedArray) && parsedArray.length >= 2) {
              // Use the second element as tag_uid (assfdf in your example)
              tag_uid = parsedArray[1];
            } else {
              tag_uid = form_data; // Use the whole string if parsing fails
            }
          } else {
            tag_uid = form_data;
          }
        } catch (parseError) {
          tag_uid = form_data; // Use the original value if parsing fails
        }
      } else {
        // If no form_data, check if the object has a single key-value pair
        const keys = Object.keys(tagData);
        if (keys.length === 1) {
          const key = keys[0];
          const value = tagData[key];
          
          // If the key looks like a tag UID (contains comma or is alphanumeric)
          if (key.includes(',') || /^[a-zA-Z0-9]+$/.test(key)) {
            tag_uid = key;
          } else if (value && typeof value === 'string') {
            tag_uid = value;
          }
        }
      }
      
      console.log(`Processing tag ${i}:`, { form_data, tag_uid, status, parent_tag_id, current_location_id });
      
      // Validation
      if (!tag_uid) {
        console.log(`Tag ${i}: Missing tag_uid`);
        errors.push({ index: i, error: 'form_data is required and must contain valid tag_uid' });
        continue;
      }
      
      if (!['available', 'reserved', 'assigned', 'consumed', 'lost', 'damaged'].includes(status)) {
        console.log(`Tag ${i}: Invalid status: ${status}`);
        errors.push({ index: i, error: 'Invalid status. Must be one of: available, reserved, assigned, consumed, lost, damaged' });
        continue;
      }
      
      // Validate parent_tag_id if provided
      if (parent_tag_id !== null && parent_tag_id !== undefined) {
        const parentExists = await pool.query(
          'SELECT id FROM rfid_tags WHERE id = $1',
          [parent_tag_id]
        );
        if (parentExists.rows.length === 0) {
          errors.push({ index: i, error: 'Invalid parent_tag_id: parent tag does not exist' });
          continue;
        }
      }
      
      // Validate current_location_id if provided
      if (current_location_id !== null && current_location_id !== undefined) {
        const locationExists = await pool.query(
          'SELECT id FROM locations WHERE id = $1',
          [current_location_id]
        );
        if (locationExists.rows.length === 0) {
          errors.push({ index: i, error: 'Invalid current_location_id: location does not exist' });
          continue;
        }
      }
      
      try {
        // Check if tag already exists
        console.log(`Tag ${i}: Checking if exists...`);
        const existingTag = await pool.query(
          'SELECT id FROM rfid_tags WHERE tag_uid = $1',
          [tag_uid]
        );
        
        if (existingTag.rows.length > 0) {
          console.log(`Tag ${i}: Already exists`);
          errors.push({ index: i, error: 'RFID tag with this UID already exists' });
          continue;
        }
        
        // Insert new tag with all fields
        console.log(`Tag ${i}: Inserting...`);
        const result = await pool.query(
          'INSERT INTO rfid_tags (tag_uid, status, parent_tag_id, current_location_id) VALUES ($1, $2, $3, $4) RETURNING *',
          [tag_uid, status, parent_tag_id, current_location_id]
        );
        
        console.log(`Tag ${i}: Inserted successfully:`, result.rows[0]);
        results.push(result.rows[0]);
      } catch (dbError) {
        console.error(`Tag ${i}: Database error:`, dbError);
        errors.push({ index: i, error: `Database error: ${dbError.message}` });
      }
    }
    
    console.log('Final results:', results);
    console.log('Final errors:', errors);
    
    // Return response based on whether it's single or multiple tags
    if (Array.isArray(requestData)) {
      res.status(201).json({
        success: true,
        message: `Created ${results.length} RFID tags`,
        data: results,
        errors: errors.length > 0 ? errors : undefined
      });
    } else {
      if (results.length > 0) {
        res.status(201).json({
          success: true,
          message: 'RFID tag created successfully',
          data: results[0]
        });
      } else {
        res.status(400).json({
          success: false,
          message: 'Failed to create RFID tag',
          errors: errors
        });
      }
    }
  } catch (error) {
    console.error('=== RFID POST Error ===');
    console.error('Error details:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Error creating RFID tag',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// PUT /api/rfid/:tag_uid - Update RFID tag
app.put('/api/rfid/:tag_uid', async (req, res) => {
  try {
    const { tag_uid } = req.params;
    const { status, parent_tag_id, current_location_id } = req.body;
    
    // Check if at least one field is provided for update
    if (!status && parent_tag_id === undefined && current_location_id === undefined) {
      return res.status(400).json({
        success: false,
        message: 'At least one field (status, parent_tag_id, or current_location_id) is required for update'
      });
    }
    
    // Validate status if provided
    if (status && !['available', 'reserved', 'assigned', 'consumed', 'lost', 'damaged'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be one of: available, reserved, assigned, consumed, lost, damaged'
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
    
    if (parent_tag_id !== undefined) {
      updateFields.push(`parent_tag_id = $${paramCount}`);
      values.push(parent_tag_id);
      paramCount++;
    }
    
    if (current_location_id !== undefined) {
      updateFields.push(`current_location_id = $${paramCount}`);
      values.push(current_location_id);
      paramCount++;
    }
    
    // Always update the updated_at timestamp
    updateFields.push(`updated_at = NOW()`);
    
    // Add tag_uid parameter
    values.push(tag_uid);
    
    const query = `UPDATE rfid_tags SET ${updateFields.join(', ')} WHERE tag_uid = $${paramCount} RETURNING *`;
    
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

// DELETE /api/rfid/:tag_uid - Delete RFID tag by tag_uid
app.delete('/api/rfid/tag-id/:tag_uid', async (req, res) => {
  try {
    const { tag_uid } = req.params;
    
    const result = await pool.query(
      'DELETE FROM rfid_tags WHERE tag_uid = $1 RETURNING *',
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

// POST /api/rfid/bulk - Create multiple RFID tags
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
        const { tag_uid, status = 'available', parent_tag_id = null, current_location_id = null } = tags[i];
        
        if (!tag_uid) {
          errors.push({ index: i, error: 'tag_uid is required' });
          continue;
        }
        
        if (!['available', 'reserved', 'assigned', 'consumed', 'lost', 'damaged'].includes(status)) {
          errors.push({ index: i, error: 'Invalid status' });
          continue;
        }
        
        // Validate parent_tag_id if provided
        if (parent_tag_id !== null && parent_tag_id !== undefined) {
          const parentExists = await client.query(
            'SELECT id FROM rfid_tags WHERE id = $1',
            [parent_tag_id]
          );
          if (parentExists.rows.length === 0) {
            errors.push({ index: i, error: 'Invalid parent_tag_id: parent tag does not exist' });
            continue;
          }
        }
        
        // Validate current_location_id if provided
        if (current_location_id !== null && current_location_id !== undefined) {
          const locationExists = await client.query(
            'SELECT id FROM locations WHERE id = $1',
            [current_location_id]
          );
          if (locationExists.rows.length === 0) {
            errors.push({ index: i, error: 'Invalid current_location_id: location does not exist' });
            continue;
          }
        }
        
        try {
          const result = await client.query(
            'INSERT INTO rfid_tags (tag_uid, status, parent_tag_id, current_location_id) VALUES ($1, $2, $3, $4) RETURNING *',
            [tag_uid, status, parent_tag_id, current_location_id]
          );
          results.push(result.rows[0]);
        } catch (error) {
          if (error.code === '23505') { // Unique violation
            errors.push({ index: i, error: 'RFID tag already exists' });
          } else {
            errors.push({ index: i, error: error.message });
          }
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
