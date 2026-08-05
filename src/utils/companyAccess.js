import pool from "../db/index.js";
   
import { DB_SCHEMA } from "../config/db.js";

   export function validateCompanyId(companyId) {
     const id = Number(companyId);
     return !id || isNaN(id) ? null : id;
   }
   
   export async function checkCompanyAccess(userId, companyId) {
     const result = await pool.query(
       `SELECT 1 FROM ${DB_SCHEMA}.user_companies
        WHERE user_id = $1 AND company_id = $2`,
       [userId, companyId]
     );
     return result.rows.length > 0;
   }
   
   export default {
     checkCompanyAccess,
     validateCompanyId
   };