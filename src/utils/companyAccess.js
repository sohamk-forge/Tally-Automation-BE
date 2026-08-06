import pool from "../db/index.js";
   
   export function validateCompanyId(companyId) {
     const id = Number(companyId);
     return !id || isNaN(id) ? null : id;
   }
   
   export async function checkCompanyAccess(userId, companyId) {
     const result = await pool.query(
       `SELECT 1 FROM app_test.user_companies
        WHERE user_id = $1 AND company_id = $2`,
       [userId, companyId]
     );
     return result.rows.length > 0;
   }
   
   export default {
     checkCompanyAccess,
     validateCompanyId
   };