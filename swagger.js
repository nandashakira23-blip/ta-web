const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const publicUrl = process.env.APP_PUBLIC_URL || 'https://fleurpresensi.online';
const localUrl = `http://localhost:${process.env.PORT || 3000}`;

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Presensi System API',
      version: '1.0.0',
      description: 'API untuk sistem presensi dengan face recognition dan validasi lokasi GPS',
      contact: {
        name: 'API Support',
        email: 'support@attendance.com'
      }
    },
    servers: [
      {
        url: publicUrl,
        description: 'Production (HTTPS) - fleurpresensi.online'
      },
      {
        url: localUrl,
        description: 'Local / dev'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter JWT token'
        }
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: false
            },
            message: {
              type: 'string',
              example: 'Error message'
            },
            code: {
              type: 'string',
              example: 'ERROR_CODE'
            }
          }
        },
        BreakSession: {
          type: 'object',
          properties: {
            mulai: {
              type: 'string',
              example: '2026-05-04 12:00:00'
            },
            selesai: {
              type: 'string',
              nullable: true,
              example: '2026-05-04 12:30:00'
            },
            durasi_menit: {
              type: 'integer',
              example: 30
            },
            lokasi_selesai: {
              type: 'object',
              nullable: true,
              properties: {
                latitude: {
                  type: 'number',
                  example: -8.3974062
                },
                longitude: {
                  type: 'number',
                  example: 115.54240086
                },
                jarak_meter: {
                  type: 'number',
                  example: 0
                },
                valid: {
                  type: 'boolean',
                  example: true
                }
              }
            },
            auto_closed: {
              type: 'boolean',
              example: false
            },
            auto_closed_reason: {
              type: 'string',
              nullable: true,
              example: 'clock_out'
            }
          }
        },
        BreakInfo: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['belum_mulai', 'berlangsung', 'selesai'],
              example: 'berlangsung'
            },
            total_menit: {
              type: 'integer',
              example: 30
            },
            durasi_aktif_menit: {
              type: 'integer',
              example: 10
            },
            total_berjalan_menit: {
              type: 'integer',
              example: 40
            },
            durasi_istirahat_menit: {
              type: 'integer',
              example: 60
            },
            dihitung_menit: {
              type: 'integer',
              description: 'Durasi istirahat yang dipakai untuk pengurangan jam kerja. Minimum mengikuti jatah istirahat jika ada sesi istirahat.',
              example: 60
            },
            sisa_istirahat_menit: {
              type: 'integer',
              example: 20
            },
            kelebihan_istirahat_menit: {
              type: 'integer',
              example: 0
            },
            sesi: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/BreakSession'
              }
            },
            sedang_istirahat: {
              type: 'boolean',
              example: true
            },
            mulai_aktif: {
              type: 'string',
              nullable: true,
              example: '2026-05-04 12:00:00'
            },
            canStartBreak: {
              type: 'boolean',
              example: false
            },
            canEndBreak: {
              type: 'boolean',
              example: true
            }
          }
        }
      },
      responses: {
        UnauthorizedError: {
          description: 'Access token is missing or invalid',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error'
              },
              example: {
                success: false,
                message: 'Invalid or expired token',
                code: 'TOKEN_INVALID'
              }
            }
          }
        },
        ForbiddenError: {
          description: 'Access denied',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error'
              },
              example: {
                success: false,
                message: 'Access denied',
                code: 'ACCESS_DENIED'
              }
            }
          }
        },
        ValidationError: {
          description: 'Validation error',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error'
              },
              example: {
                success: false,
                message: 'Validation failed',
                code: 'VALIDATION_ERROR'
              }
            }
          }
        },
        ServerError: {
          description: 'Internal server error',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error'
              },
              example: {
                success: false,
                message: 'Internal server error',
                code: 'SERVER_ERROR'
              }
            }
          }
        }
      }
    },
    tags: [
      {
        name: 'System',
        description: 'Health check service dan koneksi database'
      },
      {
        name: 'Authentication',
        description: 'API untuk autentikasi karyawan'
      },
      {
        name: 'Activation',
        description: 'API untuk aktivasi akun karyawan'
      },
      {
        name: 'Presensi',
        description: 'API untuk presensi (clock in/out)'
      },
      {
        name: 'Attendance',
        description: 'API attendance kompatibilitas'
      },
      {
        name: 'Validation',
        description: 'API untuk validasi lokasi dan wajah'
      },
      {
        name: 'Settings',
        description: 'API untuk pengaturan sistem'
      },
      {
        name: 'Admin Testing',
        description: 'API untuk testing face recognition (Admin only)'
      }
    ]
  },
  apis: ['./routes/api.js'], // Path to the API files
};

const specs = swaggerJsdoc(options);

module.exports = {
  specs,
  swaggerUi,
  serve: swaggerUi.serve,
  setup: swaggerUi.setup(specs, {
    explorer: true,
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Presensi System API Documentation'
  })
};
