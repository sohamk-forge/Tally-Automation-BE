import axios from "axios";

class GSTService {

  async getTaxpayerDetails(gstin) {

    try {

      if (!gstin) {
        return {
          success: false,
          message: "GSTIN is required",
          data: null
        };
      }

      const url = `${process.env.GST_API_URL}/${process.env.GST_API_KEY}/${gstin}`;

     

console.log("GST API URL:", url);

const response = await axios.get(url, {
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json"
  },
  timeout: 30000
});

console.log("================================");
console.log("GST API Response");
console.log("================================");
console.dir(response.data, { depth: null });


      if (!response.data.flag) {
        return {
          success: false,
          message: response.data.message,
          data: null
        };
      }

      return {
        success: true,
        message: response.data.message,
        data: response.data.data
      };

   } catch (error) {

  console.error("================================");
  console.error("GST API ERROR");
  console.error("================================");
  console.error(error.response?.data || error.message);

  return {
    success: false,
    message:
      error.response?.data?.message ||
      error.message,
    data: null
  };

}

  }

}

export default new GSTService();