export default function errorHandler(err, req,res,next){
    console.error(err);
    return res.status(500).json({error:"internal server error"});
}