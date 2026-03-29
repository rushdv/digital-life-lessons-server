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
    origin: [
      "http://localhost:5173",
      "https://your-live-site.netlify.app", // deploy করলে এখানে live URL দাও
    ],
    credentials: true,
  })
);

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
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Collections — globally accessible
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

    // Admin Verify
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin") {
        return res.status(403).json({ message: "Admin only access" });
      }
      next();
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
    // ══════════════════════════════════════

    // Save user to DB (called after register/google login)
    app.post("/users", async (req, res) => {
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
    });

    // Get user status (premium check)
    app.get("/users/status/:email", async (req, res) => {
      const user = await usersCollection.findOne({
        email: req.params.email,
      });
      res.json({ isPremium: user?.isPremium || false });
    });

    // Get user role
    app.get("/users/role/:email", verifyToken, async (req, res) => {
      const user = await usersCollection.findOne({
        email: req.params.email,
      });
      res.json({ role: user?.role || "user" });
    });

    // Get all users (admin only)
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const users = await usersCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      res.json(users);
    });

    // Update user role (admin only)
    app.patch("/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { role: req.body.role } }
      );
      res.json(result);
    });

    // Update user profile
    app.patch("/users/profile/:email", verifyToken, async (req, res) => {
      const result = await usersCollection.updateOne(
        { email: req.params.email },
        { $set: req.body }
      );
      res.json(result);
    });

    // Top contributors (for home page)
    app.get("/users/top-contributors", async (req, res) => {
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
    });

    // ══════════════════════════════════════
    // LESSONS ROUTES
    // ══════════════════════════════════════

    // Create lesson
    app.post("/lessons", verifyToken, async (req, res) => {
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
    });

    // Get public lessons (with filter, sort, search, pagination)
    app.get("/lessons/public", async (req, res) => {
      const {
        category,
        tone,
        search,
        sort,
        page = 1,
        limit = 9,
      } = req.query;

      const query = { visibility: "public" };
      if (category) query.category = category;
      if (tone) query.emotionalTone = tone;
      if (search) query.title = { $regex: search, $options: "i" };

      const sortOption =
        sort === "most-saved"
          ? { favoritesCount: -1 }
          : { createdAt: -1 };

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const total = await lessonsCollection.countDocuments(query);
      const lessons = await lessonsCollection
        .find(query)
        .sort(sortOption)
        .skip(skip)
        .limit(parseInt(limit))
        .toArray();

      res.json({ lessons, total, page: parseInt(page) });
    });

    // Get featured lessons
    app.get("/lessons/featured", async (req, res) => {
      const lessons = await lessonsCollection
        .find({ isFeatured: true, visibility: "public" })
        .sort({ createdAt: -1 })
        .limit(6)
        .toArray();
      res.json(lessons);
    });

    // Get my lessons
    app.get("/lessons/my-lessons", verifyToken, async (req, res) => {
      const lessons = await lessonsCollection
        .find({ creatorEmail: req.decoded.email })
        .sort({ createdAt: -1 })
        .toArray();
      res.json(lessons);
    });

    // Get lessons by creator email (for profile page)
    app.get("/lessons/by-creator/:email", async (req, res) => {
      const lessons = await lessonsCollection
        .find({
          creatorEmail: req.params.email,
          visibility: "public",
        })
        .sort({ createdAt: -1 })
        .toArray();
      res.json(lessons);
    });

    // Get single lesson
    app.get("/lessons/:id", async (req, res) => {
      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      res.json(lesson);
    });

    // Update lesson
    app.put("/lessons/:id", verifyToken, async (req, res) => {
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
    });

    // Delete lesson
    app.delete("/lessons/:id", verifyToken, async (req, res) => {
      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      const user = await usersCollection.findOne({
        email: req.decoded.email,
      });

      const isOwner = lesson?.creatorEmail === req.decoded.email;
      const isAdmin = user?.role === "admin";

      if (!isOwner && !isAdmin) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const result = await lessonsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.json(result);
    });

    // Toggle like
    app.patch("/lessons/:id/like", verifyToken, async (req, res) => {
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
    });

    // Toggle featured (admin only)
    app.patch(
      "/lessons/:id/featured",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const result = await lessonsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { isFeatured: req.body.isFeatured } }
        );
        res.json(result);
      }
    );

    // Add comment
    app.post("/lessons/:id/comments", verifyToken, async (req, res) => {
      const result = await lessonsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $push: {
            comments: {
              ...req.body,
              createdAt: new Date(),
            },
          },
        }
      );
      res.json(result);
    });

    // ══════════════════════════════════════
    // FAVORITES ROUTES
    // ══════════════════════════════════════

    // Add to favorites
    app.post("/favorites", verifyToken, async (req, res) => {
      const { lessonId } = req.body;
      const email = req.decoded.email;

      const existing = await favoritesCollection.findOne({
        lessonId,
        userEmail: email,
      });

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
    });

    // Remove from favorites
    app.delete("/favorites/:lessonId", verifyToken, async (req, res) => {
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
    });

    // Get my favorites
    app.get("/favorites", verifyToken, async (req, res) => {
      const favorites = await favoritesCollection
        .find({ userEmail: req.decoded.email })
        .toArray();

      const lessonIds = favorites.map((f) => new ObjectId(f.lessonId));

      const lessons = await lessonsCollection
        .find({ _id: { $in: lessonIds } })
        .toArray();

      res.json(lessons);
    });

    // ══════════════════════════════════════
    // REPORTS ROUTES
    // ══════════════════════════════════════

    // Submit report
    app.post("/reports", verifyToken, async (req, res) => {
      const report = {
        ...req.body,
        reporterUserId: req.decoded.email,
        timestamp: new Date(),
      };
      const result = await reportsCollection.insertOne(report);
      res.json(result);
    });

    // Get all reports grouped by lesson (admin only)
    app.get("/reports", verifyToken, verifyAdmin, async (req, res) => {
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
                },
              },
            },
          },
          { $sort: { reportCount: -1 } },
        ])
        .toArray();
      res.json(reports);
    });

    // ══════════════════════════════════════
    // ADMIN ROUTES
    // ══════════════════════════════════════

    // Admin stats
    app.get("/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
      const totalUsers = await usersCollection.countDocuments();
      const totalPublicLessons = await lessonsCollection.countDocuments({
        visibility: "public",
      });
      const reportedLessons = await reportsCollection.distinct("lessonId");

      res.json({
        totalUsers,
        totalPublicLessons,
        totalReported: reportedLessons.length,
      });
    });

    // Get all lessons (admin)
    app.get("/admin/lessons", verifyToken, verifyAdmin, async (req, res) => {
      const lessons = await lessonsCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      res.json(lessons);
    });

    // ══════════════════════════════════════
    // STRIPE PAYMENT
    // ══════════════════════════════════════

    app.post("/create-checkout-session", verifyToken, async (req, res) => {
      const { email } = req.body;

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd", // BDT Stripe-এ test mode-এ support করে না, তাই USD দাও
              product_data: {
                name: "Digital Life Lessons — Premium (Lifetime)",
                description: "Unlimited lessons, premium content, ad-free experience",
              },
              unit_amount: 1500, // $15.00 (তুমি চাইলে ৳1500 represent করতে পারো)
            },
            quantity: 1,
          },
        ],
        metadata: { email },
        success_url: `${process.env.CLIENT_URL}/payment/success`,
        cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
      });

      res.json({ url: session.url });
    });

    // ══════════════════════════════════════
    // TEST ROUTE
    // ══════════════════════════════════════
    app.get("/", (req, res) => {
      res.json({ message: "Digital Life Lessons Server is running ✅" });
    });

    // ══════════════════════════════════════
    // START SERVER
    // ══════════════════════════════════════
    app.listen(port, () => {
      console.log(`🚀 Server running on port ${port}`);
    });
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}

run();