// import axios from "axios";

// class SandboxAuthService {
//   constructor() {
//     this.accessToken = null;
//     this.expiresAt = 0;
//   }

//   async getAccessToken() {
//     try {
//       // Reuse token if still valid
//       if (this.accessToken && Date.now() < this.expiresAt) {
//         return this.accessToken;
//       }

//       const response = await axios.post(
//   `${process.env.SANDBOX_BASE_URL}/authenticate`,
//         {},
//         {
//           headers: {
//             "x-api-key": process.env.SANDBOX_API_KEY,
//             "x-api-secret": process.env.SANDBOX_API_SECRET,
//             "x-api-version": "1.0"
//           }
//         }
//       );

//       // Check authentication response
//       if (response.data.code !== 200) {
//         throw new Error("Sandbox authentication failed");
//       }

//       this.accessToken = response.data.data.access_token;
//       // Token valid for 24 hours
//       this.expiresAt = Date.now() + 23 * 60 * 60 * 1000;

//       console.log("✅ Sandbox Access Token Generated");

//       return this.accessToken;

//     } catch (error) {
//       console.error("================================");
//       console.error("SANDBOX AUTH ERROR");
//       console.error("================================");
//       console.error(error.response?.data || error.message);

//       throw error;
//     }
//   }
// }

// export default new SandboxAuthService();