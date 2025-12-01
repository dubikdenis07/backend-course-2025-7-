// main.js
import { Command } from "commander";
import express from "express";
import multer from "multer";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

// CLI з можливістю fallback на .env
const program = new Command();
program
  .option("-h, --host <string>", "адреса сервера (host)", process.env.HOST || "localhost")
  .option("-p, --port <number>", "порт сервера (port)", process.env.PORT || 3000)
  .option("-c, --cache <string>", "шлях до директорії кешу (cache)", process.env.CACHE_DIR || "./cache");

program.parse(process.argv);
const options = program.opts();

// Підготувати кеш-директорію
const cacheDir = path.resolve(options.cache);
if (!fs.existsSync(cacheDir)) {
  console.log(`Директорія кешу не знайдена. Створюю: ${cacheDir}`);
  fs.mkdirSync(cacheDir, { recursive: true });
} else {
  console.log(`Кеш-директорія існує: ${cacheDir}`);
}

// Підготувати uploads папку
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
console.log("Uploads dir:", uploadDir);

// Налаштування DB (Postgres)
const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "inventory",
});

// Перевірка підключення та створення таблиці на всякий випадок
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        photo VARCHAR(255),
        created_at TIMESTAMP DEFAULT now()
      );
    `);
    console.log("DB initialized / ready");
  } catch (err) {
    console.error("DB init error:", err);
    process.exit(1);
  }
}
await initDb();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Swagger setup
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Inventory API",
      version: "1.0.0",
      description: "API documentation for Inventory service",
    },
  },
  apis: ["./main.js"],
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage });

// ----------------- ROUTES -----------------

/**
 * @openapi
 * /register:
 *   post:
 *     summary: Create a new inventory item
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               inventory_name:
 *                 type: string
 *               description:
 *                 type: string
 *               photo:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Item created
 */
app.post("/register", upload.single("photo"), async (req, res) => {
  try {
    const { inventory_name, description } = req.body;
    if (!inventory_name) return res.status(400).send("Bad Request: inventory_name обов'язкове");
    const photo = req.file ? req.file.filename : null;

    const result = await pool.query(
      "INSERT INTO inventory (name, description, photo) VALUES ($1, $2, $3) RETURNING id, name, description, photo, created_at",
      [inventory_name, description || null, photo]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /register error:", err);
    res.status(500).send("DB error");
  }
});

/**
 * @openapi
 * /inventory:
 *   get:
 *     summary: Get all inventory items
 *     responses:
 *       200:
 *         description: List of inventory items
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   name:
 *                     type: string
 *                   description:
 *                     type: string
 *                   photo_url:
 *                     type: string
 */
app.get("/inventory", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, description, photo FROM inventory ORDER BY id");
    const rows = result.rows.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      photo_url: item.photo ? `/inventory/${item.id}/photo` : null
    }));
    res.status(200).json(rows);
  } catch (err) {
    console.error("GET /inventory error:", err);
    res.status(500).send("DB error");
  }
});

/**
 * @openapi
 * /inventory/{id}:
 *   get:
 *     summary: Get a single inventory item by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Inventory item
 *       404:
 *         description: Not Found
 */
app.get("/inventory/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query("SELECT id, name, description, photo FROM inventory WHERE id=$1", [id]);
    if (result.rows.length === 0) return res.status(404).send("Not Found");
    const item = result.rows[0];
    res.status(200).json({
      id: item.id,
      name: item.name,
      description: item.description,
      photo_url: item.photo ? `/inventory/${item.id}/photo` : null
    });
  } catch (err) {
    console.error("GET /inventory/:id error:", err);
    res.status(500).send("DB error");
  }
});

/**
 * @openapi
 * /inventory/{id}:
 *   put:
 *     summary: Update an inventory item
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               inventory_name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Updated item
 *       404:
 *         description: Not Found
 */
app.put("/inventory/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { inventory_name, description } = req.body;
    const exists = await pool.query("SELECT id FROM inventory WHERE id=$1", [id]);
    if (exists.rows.length === 0) return res.status(404).send("Not Found");

    const updated = await pool.query(
      "UPDATE inventory SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id=$3 RETURNING id, name, description, photo",
      [inventory_name || null, description || null, id]
    );
    res.status(200).json(updated.rows[0]);
  } catch (err) {
    console.error("PUT /inventory/:id error:", err);
    res.status(500).send("DB error");
  }
});

/**
 * @openapi
 * /inventory/{id}/photo:
 *   get:
 *     summary: Get photo of an inventory item
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Image file
 *       404:
 *         description: Photo Not Found
 */
app.get("/inventory/:id/photo", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query("SELECT photo FROM inventory WHERE id=$1", [id]);
    if (result.rows.length === 0) return res.status(404).send("Not Found");
    const photo = result.rows[0].photo;
    if (!photo) return res.status(404).send("Photo Not Found");
    const photoPath = path.join(uploadDir, photo);
    if (!fs.existsSync(photoPath)) return res.status(404).send("Photo Not Found");
    res.setHeader("Content-Type", "image/jpeg");
    res.sendFile(photoPath);
  } catch (err) {
    console.error("GET /inventory/:id/photo error:", err);
    res.status(500).send("DB error");
  }
});

/**
 * @openapi
 * /inventory/{id}/photo:
 *   put:
 *     summary: Update photo of an inventory item
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               photo:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Updated item
 *       404:
 *         description: Not Found
 */
app.put("/inventory/:id/photo", upload.single("photo"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query("SELECT photo FROM inventory WHERE id=$1", [id]);
    if (result.rows.length === 0) return res.status(404).send("Not Found");
    if (!req.file) return res.status(400).send("Bad Request: photo file required");

    const oldPhoto = result.rows[0].photo;
    if (oldPhoto) {
      const oldPath = path.join(uploadDir, oldPhoto);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    const filename = req.file.filename;
    const updated = await pool.query("UPDATE inventory SET photo=$1 WHERE id=$2 RETURNING id, name, description, photo", [filename, id]);
    res.status(200).json(updated.rows[0]);
  } catch (err) {
    console.error("PUT /inventory/:id/photo error:", err);
    res.status(500).send("DB error");
  }
});

/**
 * @openapi
 * /inventory/{id}:
 *   delete:
 *     summary: Delete an inventory item
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Deleted successfully
 *       404:
 *         description: Not Found
 */
app.delete("/inventory/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query("SELECT photo FROM inventory WHERE id=$1", [id]);
    if (result.rows.length === 0) return res.status(404).send("Not Found");
    const photo = result.rows[0].photo;
    if (photo) {
      const photoPath = path.join(uploadDir, photo);
      if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
    }
    await pool.query("DELETE FROM inventory WHERE id=$1", [id]);
    res.status(200).send("Deleted successfully");
  } catch (err) {
    console.error("DELETE /inventory/:id error:", err);
    res.status(500).send("DB error");
  }
});

/**
 * @openapi
 * /RegisterForm.html:
 *   get:
 *     summary: Get HTML form for creating new inventory
 *     responses:
 *       200:
 *         description: HTML file
 *       404:
 *         description: Not Found
 */
app.get("/RegisterForm.html", (req, res) => {
  const filePath = path.join(process.cwd(), "RegisterForm.html");
  if (!fs.existsSync(filePath)) return res.status(404).send("File Not Found");
  res.sendFile(filePath);
});

/**
 * @openapi
 * /SearchForm.html:
 *   get:
 *     summary: Get HTML form for searching inventory
 *     responses:
 *       200:
 *         description: HTML file
 *       404:
 *         description: Not Found
 */
app.get("/SearchForm.html", (req, res) => {
  const filePath = path.join(process.cwd(), "SearchForm.html");
  if (!fs.existsSync(filePath)) return res.status(404).send("File Not Found");
  res.sendFile(filePath);
});

/**
 * @openapi
 * /search:
 *   post:
 *     summary: Search inventory by ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             properties:
 *               id:
 *                 type: integer
 *               has_photo:
 *                 type: string
 *     responses:
 *       200:
 *         description: Inventory item
 *       404:
 *         description: Not Found
 */
app.post("/search", async (req, res) => {
  try {
    const id = Number(req.body.id);
    const hasPhoto = req.body.has_photo === "on";
    const result = await pool.query("SELECT id, name, description, photo FROM inventory WHERE id=$1", [id]);
    if (result.rows.length === 0) return res.status(404).send("Not Found");
    const item = result.rows[0];
    const response = {
      id: item.id,
      name: item.name,
      description: item.description
    };
    if (hasPhoto && item.photo) response.description = (response.description || "") + `\nФото: /inventory/${item.id}/photo`;
    res.status(200).json(response);
  } catch (err) {
    console.error("POST /search error:", err);
    res.status(500).send("DB error");
  }
});

// Fallback 404
app.use((req, res) => {
  res.status(404).send("Not Found");
});

// Start server
const port = Number(options.port);
const host = options.host;
app.listen(port, host, () => {
  console.log(`Сервер запущено на http://${host}:${port}`);
  console.log(`Swagger UI: http://${host}:${port}/docs`);
});
