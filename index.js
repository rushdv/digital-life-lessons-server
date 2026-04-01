const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const jwt = require("jsonwebtoken");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ─────────────────────────────────────────
// CORS
// ─────────────────────────────────────────
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (origin.startsWith("http://localhost:")) return callback(null, true);
      const allowedOrigins = [
        "https://your-live-site.netlify.app",
      ];
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("*", cors());

// ─────────────────────────────────────────
// Stripe Webhook — express.json() এর আগে রাখতে হবে
// ─────────────────────────────────────────
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("Webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.metadata.email;
      await usersCollection.updateOne(
        { email },
        { $set: { isPremium: true } }
      );
      console.log(`✅ Premium activated for: ${email}`);
    }

    res.json({ received: true });
  }
);

// ─────────────────────────────────────────
// Normal Middleware
// ─────────────────────────────────────────
app.use(express.json());

// ─────────────────────────────────────────
// MongoDB Connection
// ─────────────────────────────────────────
const uri = `mongodb+srv://BiteBridgeAdmin:strongpassword@cluster0.yjx8oew.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: true,
  },
});

let usersCollection;
let lessonsCollection;
let favoritesCollection;
let reportsCollection;

// ─────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────
async function run() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db("digitalLifeLessons");
    usersCollection = db.collection("users");
    lessonsCollection = db.collection("lessons");
    favoritesCollection = db.collection("favorites");
    reportsCollection = db.collection("lessonsReports");

    // ══════════════════════════════════════
    // MIDDLEWARE — Token Verify
    // ══════════════════════════════════════
    const verifyToken = (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ message: "Unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
          return res.status(403).json({ message: "Forbidden access" });
        }
        req.decoded = decoded;
        next();
      });
    };

    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.decoded.email;
        const user = await usersCollection.findOne({ email });
        if (user?.role !== "admin") {
          return res.status(403).json({ message: "Admin only access" });
        }
        next();
      } catch (err) {
        next(err);
      }
    };

    const verifyPremium = async (req, res, next) => {
      try {
        const email = req.decoded.email;
        const user = await usersCollection.findOne({ email });
        if (!user?.isPremium) {
          return res.status(403).json({ message: "Premium access required" });
        }
        next();
      } catch (err) {
        next(err);
      }
    };

    // ══════════════════════════════════════
    // JWT ROUTE
    // ══════════════════════════════════════
    app.post("/jwt", (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });
      res.json({ token });
    });

    // ══════════════════════════════════════
    // USERS ROUTES
    // ✅ FIX: Specific routes আগে, dynamic :email/:id routes শেষে
    // ══════════════════════════════════════

    // Save user to DB
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        const existing = await usersCollection.findOne({ email: user.email });
        if (existing) {
          return res.json({ message: "User already exists", insertedId: null });
        }
        const result = await usersCollection.insertOne({
          name: user.name,
          email: user.email,
          photo: user.photo,
          role: "user",
          isPremium: false,
          createdAt: new Date(),
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /users/status/:email — specific, আগে থাকবে
    app.get("/users/status/:email", async (req, res) => {
      try {
        const user = await usersCollection.findOne({
          email: req.params.email,
        });
        res.json({ isPremium: user?.isPremium || false });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /users/role/:email — specific, আগে থাকবে
    app.get("/users/role/:email", verifyToken, async (req, res) => {
      try {
        const user = await usersCollection.findOne({
          email: req.params.email,
        });
        res.json({ role: user?.role || "user" });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /users/top-contributors — static path, আগে থাকবে
    app.get("/users/top-contributors", async (req, res) => {
      try {
        const contributors = await lessonsCollection
          .aggregate([
            { $match: { visibility: "public" } },
            {
              $group: {
                _id: "$creatorEmail",
                lessonCount: { $sum: 1 },
                name: { $first: "$creatorName" },
                photo: { $first: "$creatorPhoto" },
              },
            },
            { $sort: { lessonCount: -1 } },
            { $limit: 6 },
          ])
          .toArray();
        res.json(contributors);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /users/lesson-count/:email — specific, আগে থাকবে
    app.get("/users/lesson-count/:email", async (req, res) => {
      try {
        const count = await lessonsCollection.countDocuments({
          creatorEmail: req.params.email,
          visibility: "public",
        });
        res.json({ count });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Get all users (admin only)
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();
        res.json(users);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Update user role (admin only)
    app.patch("/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role: req.body.role } }
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Update user profile
    app.patch("/users/profile/:email", verifyToken, async (req, res) => {
      try {
        const result = await usersCollection.updateOne(
          { email: req.params.email },
          { $set: req.body }
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /users/:email — MUST be LAST in users routes (dynamic param)
    app.get("/users/:email", async (req, res) => {
      try {
        const user = await usersCollection.findOne({ email: req.params.email });
        if (!user) return res.status(404).json({ message: "User not found" });
        res.json(user);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ Delete user — dynamic :id, শেষে থাকবে
    app.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await usersCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ══════════════════════════════════════
    // LESSONS ROUTES
    // ✅ FIX: Specific/static routes আগে, dynamic :id routes শেষে
    // ══════════════════════════════════════

    // Create lesson
    app.post("/lessons", verifyToken, async (req, res) => {
      try {
        const lesson = {
          ...req.body,
          likesCount: 0,
          likes: [],
          favoritesCount: 0,
          comments: [],
          isFeatured: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const result = await lessonsCollection.insertOne(lesson);
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /lessons/public — static path, আগে থাকবে
    app.get("/lessons/public", async (req, res) => {
      try {
        const { category, tone, search, sort, page = 1, limit = 9 } = req.query;

        const query = { visibility: "public" };
        if (category) query.category = category;
        if (tone) query.emotionalTone = tone;
        if (search) query.title = { $regex: search, $options: "i" };

        const sortOption =
          sort === "most-saved" ? { favoritesCount: -1 } : { createdAt: -1 };

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await lessonsCollection.countDocuments(query);
        const lessons = await lessonsCollection
          .find(query)
          .sort(sortOption)
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        let viewerIsPremium = false;
        const authHeader = req.headers.authorization;
        if (authHeader) {
          try {
            const token = authHeader.split(" ")[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const viewer = await usersCollection.findOne({ email: decoded.email });
            viewerIsPremium = viewer?.isPremium || false;
          } catch (_) {}
        }

        const result = lessons.map((lesson) => {
          if (lesson.accessLevel === "premium" && !viewerIsPremium) {
            return {
              _id: lesson._id,
              title: lesson.title,
              category: lesson.category,
              emotionalTone: lesson.emotionalTone,
              creatorName: lesson.creatorName,
              creatorPhoto: lesson.creatorPhoto,
              creatorEmail: lesson.creatorEmail,
              accessLevel: lesson.accessLevel,
              visibility: lesson.visibility,
              likesCount: lesson.likesCount,
              favoritesCount: lesson.favoritesCount,
              createdAt: lesson.createdAt,
              isPremiumLocked: true,
            };
          }
          return { ...lesson, isPremiumLocked: false };
        });

        res.json({ lessons: result, total, page: parseInt(page) });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /lessons/most-saved — static path, আগে থাকবে
    app.get("/lessons/most-saved", async (req, res) => {
      try {
        const lessons = await lessonsCollection
          .find({ visibility: "public", accessLevel: "free" })
          .sort({ favoritesCount: -1 })
          .limit(6)
          .toArray();
        res.json(lessons);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /lessons/featured — static path, আগে থাকবে
    app.get("/lessons/featured", async (req, res) => {
      try {
        const lessons = await lessonsCollection
          .find({ isFeatured: true, visibility: "public" })
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();
        res.json(lessons);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /lessons/my-lessons — static path, আগে থাকবে
    app.get("/lessons/my-lessons", verifyToken, async (req, res) => {
      try {
        const lessons = await lessonsCollection
          .find({ creatorEmail: req.decoded.email })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(lessons);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /lessons/by-creator/:email — specific prefix, আগে থাকবে
    app.get("/lessons/by-creator/:email", async (req, res) => {
      try {
        const lessons = await lessonsCollection
          .find({
            creatorEmail: req.params.email,
            visibility: "public",
          })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(lessons);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /lessons/:id — dynamic param, শেষে থাকবে
    app.get("/lessons/:id", async (req, res) => {
      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!lesson) return res.status(404).json({ message: "Lesson not found" });

        if (lesson.accessLevel === "premium") {
          const authHeader = req.headers.authorization;
          if (!authHeader) {
            return res.status(403).json({ message: "Premium access required", isPremiumLocked: true });
          }
          try {
            const token = authHeader.split(" ")[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const viewer = await usersCollection.findOne({ email: decoded.email });
            const isCreator = lesson.creatorEmail === decoded.email;
            if (!viewer?.isPremium && !isCreator) {
              return res.status(403).json({ message: "Premium access required", isPremiumLocked: true });
            }
          } catch (_) {
            return res.status(403).json({ message: "Premium access required", isPremiumLocked: true });
          }
        }

        res.json(lesson);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Update lesson
    app.put("/lessons/:id", verifyToken, async (req, res) => {
      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (lesson.creatorEmail !== req.decoded.email) {
          return res.status(403).json({ message: "Forbidden" });
        }
        const result = await lessonsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { ...req.body, updatedAt: new Date() } }
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Delete lesson
    app.delete("/lessons/:id", verifyToken, async (req, res) => {
      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        const user = await usersCollection.findOne({ email: req.decoded.email });

        const isOwner = lesson?.creatorEmail === req.decoded.email;
        const isAdmin = user?.role === "admin";

        if (!isOwner && !isAdmin) {
          return res.status(403).json({ message: "Forbidden" });
        }

        const result = await lessonsCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Toggle like
    app.patch("/lessons/:id/like", verifyToken, async (req, res) => {
      try {
        const email = req.decoded.email;
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        const alreadyLiked = lesson?.likes?.includes(email);
        const result = await lessonsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          alreadyLiked
            ? { $pull: { likes: email }, $inc: { likesCount: -1 } }
            : { $push: { likes: email }, $inc: { likesCount: 1 } }
        );
        res.json({ liked: !alreadyLiked, result });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Toggle featured (admin only)
    app.patch("/lessons/:id/featured", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await lessonsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { isFeatured: req.body.isFeatured } }
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Mark lesson as reviewed (admin)
    app.patch("/lessons/:id/reviewed", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await lessonsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { isReviewed: true } }
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Change visibility
    app.patch("/lessons/:id/visibility", verifyToken, async (req, res) => {
      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (lesson?.creatorEmail !== req.decoded.email) {
          return res.status(403).json({ message: "Forbidden" });
        }
        const result = await lessonsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { visibility: req.body.visibility, updatedAt: new Date() } }
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Change access level
    app.patch("/lessons/:id/access-level", verifyToken, async (req, res) => {
      try {
        const email = req.decoded.email;
        const user = await usersCollection.findOne({ email });
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (lesson?.creatorEmail !== email) {
          return res.status(403).json({ message: "Forbidden" });
        }
        if (req.body.accessLevel === "premium" && !user?.isPremium) {
          return res.status(403).json({ message: "Premium subscription required" });
        }
        const result = await lessonsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { accessLevel: req.body.accessLevel, updatedAt: new Date() } }
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Add comment
    app.post("/lessons/:id/comments", verifyToken, async (req, res) => {
      try {
        const result = await lessonsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $push: { comments: { ...req.body, createdAt: new Date() } } }
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Similar lessons
    app.get("/lessons/:id/similar", async (req, res) => {
      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!lesson) return res.status(404).json({ message: "Lesson not found" });

        const similar = await lessonsCollection
          .find({
            _id: { $ne: new ObjectId(req.params.id) },
            visibility: "public",
            $or: [
              { category: lesson.category },
              { emotionalTone: lesson.emotionalTone },
            ],
          })
          .limit(6)
          .toArray();

        res.json(similar);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ══════════════════════════════════════
    // FAVORITES ROUTES
    // ══════════════════════════════════════

    app.post("/favorites", verifyToken, async (req, res) => {
      try {
        const { lessonId } = req.body;
        const email = req.decoded.email;

        const existing = await favoritesCollection.findOne({ lessonId, userEmail: email });
        if (existing) {
          return res.json({ message: "Already saved" });
        }

        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          { $inc: { favoritesCount: 1 } }
        );

        const result = await favoritesCollection.insertOne({
          lessonId,
          userEmail: email,
          savedAt: new Date(),
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    app.delete("/favorites/:lessonId", verifyToken, async (req, res) => {
      try {
        const email = req.decoded.email;

        await lessonsCollection.updateOne(
          { _id: new ObjectId(req.params.lessonId) },
          { $inc: { favoritesCount: -1 } }
        );

        const result = await favoritesCollection.deleteOne({
          lessonId: req.params.lessonId,
          userEmail: email,
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    app.get("/favorites", verifyToken, async (req, res) => {
      try {
        const { category, tone } = req.query;

        const favorites = await favoritesCollection
          .find({ userEmail: req.decoded.email })
          .toArray();

        const lessonIds = favorites.map((f) => new ObjectId(f.lessonId));

        const query = { _id: { $in: lessonIds } };
        if (category) query.category = category;
        if (tone) query.emotionalTone = tone;

        const lessons = await lessonsCollection.find(query).toArray();
        res.json(lessons);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ══════════════════════════════════════
    // REPORTS ROUTES
    // ✅ FIX: /reports/detailed আগে, /reports/:lessonId শেষে
    // ══════════════════════════════════════

    const VALID_REASONS = [
      "Inappropriate Content",
      "Hate Speech or Harassment",
      "Misleading or False Information",
      "Spam or Promotional Content",
      "Sensitive or Disturbing Content",
      "Other",
    ];

    app.post("/reports", verifyToken, async (req, res) => {
      try {
        const { lessonId, reason } = req.body;
        if (!VALID_REASONS.includes(reason)) {
          return res.status(400).json({ message: "Invalid report reason" });
        }
        const report = {
          lessonId,
          reason,
          reporterUserId: req.decoded.email,
          timestamp: new Date(),
        };
        const result = await reportsCollection.insertOne(report);
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /reports/detailed — static path, আগে থাকবে
    app.get("/reports/detailed", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const reports = await reportsCollection
          .aggregate([
            {
              $group: {
                _id: "$lessonId",
                reportCount: { $sum: 1 },
                reasons: {
                  $push: {
                    reason: "$reason",
                    reporter: "$reporterUserId",
                    timestamp: "$timestamp",
                  },
                },
              },
            },
            {
              $addFields: {
                lessonObjectId: {
                  $convert: { input: "$_id", to: "objectId", onError: null },
                },
              },
            },
            {
              $lookup: {
                from: "lessons",
                localField: "lessonObjectId",
                foreignField: "_id",
                as: "lessonInfo",
              },
            },
            {
              $addFields: {
                lessonTitle: { $arrayElemAt: ["$lessonInfo.title", 0] },
                creatorEmail: { $arrayElemAt: ["$lessonInfo.creatorEmail", 0] },
              },
            },
            { $project: { lessonInfo: 0, lessonObjectId: 0 } },
            { $sort: { reportCount: -1 } },
          ])
          .toArray();
        res.json(reports);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // Get all reports (admin only)
    app.get("/reports", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const reports = await reportsCollection
          .aggregate([
            {
              $group: {
                _id: "$lessonId",
                reportCount: { $sum: 1 },
                reasons: {
                  $push: { reason: "$reason", reporter: "$reporterUserId" },
                },
              },
            },
            { $sort: { reportCount: -1 } },
          ])
          .toArray();
        res.json(reports);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ✅ /reports/:lessonId — dynamic param, শেষে থাকবে
    app.delete("/reports/:lessonId", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await reportsCollection.deleteMany({
          lessonId: req.params.lessonId,
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ══════════════════════════════════════
    // DASHBOARD ROUTES
    // ══════════════════════════════════════

    app.get("/dashboard/stats", verifyToken, async (req, res) => {
      try {
        const email = req.decoded.email;
        const [totalLessons, totalFavorites, recentLessons] = await Promise.all([
          lessonsCollection.countDocuments({ creatorEmail: email }),
          favoritesCollection.countDocuments({ userEmail: email }),
          lessonsCollection
            .find({ creatorEmail: email })
            .sort({ createdAt: -1 })
            .limit(5)
            .toArray(),
        ]);
        res.json({ totalLessons, totalFavorites, recentLessons });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    app.get("/dashboard/weekly-chart", verifyToken, async (req, res) => {
      try {
        const email = req.decoded.email;
        const days = [];
        for (let i = 6; i >= 0; i--) {
          const start = new Date();
          start.setHours(0, 0, 0, 0);
          start.setDate(start.getDate() - i);
          const end = new Date(start);
          end.setDate(end.getDate() + 1);
          const count = await lessonsCollection.countDocuments({
            creatorEmail: email,
            createdAt: { $gte: start, $lt: end },
          });
          days.push({ date: start.toISOString().split("T")[0], count });
        }
        res.json(days);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ══════════════════════════════════════
    // ADMIN ROUTES
    // ══════════════════════════════════════

    app.get("/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [totalUsers, totalPublicLessons, totalPremiumUsers, reportedLessons, todayLessons] =
          await Promise.all([
            usersCollection.countDocuments(),
            lessonsCollection.countDocuments({ visibility: "public" }),
            usersCollection.countDocuments({ isPremium: true }),
            reportsCollection.distinct("lessonId"),
            lessonsCollection.countDocuments({ createdAt: { $gte: today } }),
          ]);

        const mostActiveContributors = await lessonsCollection
          .aggregate([
            { $match: { visibility: "public" } },
            {
              $group: {
                _id: "$creatorEmail",
                lessonCount: { $sum: 1 },
                name: { $first: "$creatorName" },
                photo: { $first: "$creatorPhoto" },
              },
            },
            { $sort: { lessonCount: -1 } },
            { $limit: 5 },
          ])
          .toArray();

        res.json({
          totalUsers,
          totalPublicLessons,
          totalPremiumUsers,
          totalReported: reportedLessons.length,
          todayLessons,
          mostActiveContributors,
        });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    app.get("/admin/stats/extended", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [totalUsers, totalPublicLessons, totalPremiumUsers, reportedLessons, todayLessons] =
          await Promise.all([
            usersCollection.countDocuments(),
            lessonsCollection.countDocuments({ visibility: "public" }),
            usersCollection.countDocuments({ isPremium: true }),
            reportsCollection.distinct("lessonId"),
            lessonsCollection.countDocuments({ createdAt: { $gte: today } }),
          ]);

        res.json({
          totalUsers,
          totalPublicLessons,
          totalPremiumUsers,
          totalReported: reportedLessons.length,
          todayLessons,
        });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    app.get("/admin/lessons", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { category, visibility, flagged } = req.query;
        const query = {};
        if (category) query.category = category;
        if (visibility) query.visibility = visibility;
        if (flagged === "true") {
          const reportedIds = await reportsCollection.distinct("lessonId");
          query._id = {
            $in: reportedIds
              .map((id) => { try { return new ObjectId(id); } catch (_) { return null; } })
              .filter(Boolean),
          };
        }
        const lessons = await lessonsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res.json(lessons);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    app.get("/admin/users-with-stats", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection.find().sort({ createdAt: -1 }).toArray();
        const usersWithStats = await Promise.all(
          users.map(async (user) => {
            const lessonCount = await lessonsCollection.countDocuments({
              creatorEmail: user.email,
            });
            return { ...user, lessonCount };
          })
        );
        res.json(usersWithStats);
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });

    // ══════════════════════════════════════
    // STRIPE PAYMENT
    // ══════════════════════════════════════

    app.post("/create-checkout-session", verifyToken, async (req, res) => {
      try {
        const { email } = req.body;
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: "Digital Life Lessons — Premium (Lifetime)",
                  description: "Unlimited lessons, premium content, ad-free experience",
                },
                unit_amount: 1500,
              },
              quantity: 1,
            },
          ],
          metadata: { email },
          success_url: `${process.env.CLIENT_URL}/payment/success`,
          cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
        });
        res.json({ url: session.url });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    });





    // ══════════════════════════════════════
// STRIPE WEBHOOK
// ══════════════════════════════════════

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log("Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email = session.metadata.email;

    try {
      await usersCollection.updateOne(
        { email: email },
        { $set: { isPremium: true } }
      );

      console.log(`Premium activated for ${email}`);
    } catch (err) {
      console.log("Database update error:", err);
    }
  }

  res.json({ received: true });
});

    // ══════════════════════════════════════
    // TEST ROUTE
    // ══════════════════════════════════════
    app.get("/", (req, res) => {
      res.json({ message: "Digital Life Lessons Server is running ✅" });
    });

    // ══════════════════════════════════════
    // GLOBAL ERROR HANDLER
    // ══════════════════════════════════════
    app.use((err, req, res, next) => {
      console.error("Server error:", err.message);
      res.status(err.status || 500).json({ message: err.message || "Internal server error" });
    });

    app.listen(port, () => {
      console.log(`🚀 Server running on port ${port}`);
    });
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}

run();